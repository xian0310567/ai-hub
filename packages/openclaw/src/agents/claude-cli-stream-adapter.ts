/**
 * Claude CLI의 `--output-format stream-json` JSONL 출력을 OpenClaw 내부
 * transport 이벤트로 변환하는 어댑터.
 *
 * CLI 출력 예시 (`--include-partial-messages` 활성):
 *   {"type":"system","subtype":"init","model":"claude-sonnet-4-6", ...}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"Hel"}]},"is_partial":true}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]},"is_partial":true}
 *   {"type":"result","message":{"content":[...],"stop_reason":"end_turn","usage":{...}}}
 *
 * 변환 대상은 anthropic-transport-stream.ts와 동일한 transport 이벤트 셋이다:
 *   { type: "start", partial }
 *   { type: "text_start", contentIndex, partial }
 *   { type: "text_delta", contentIndex, delta, partial }
 *   { type: "text_end", contentIndex, content, partial }
 *   { type: "thinking_start" / "thinking_delta" / "thinking_end" }
 *   { type: "toolcall_start" / "toolcall_delta" / "toolcall_end" }
 *   { type: "done", reason, message }
 *   { type: "error", reason, error }
 */

import type { ChildProcess } from "node:child_process";

export interface CliStreamContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface CliStreamMessage {
  id?: string;
  content?: CliStreamContentBlock[];
  model?: string;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface CliStreamEvent {
  type: "system" | "assistant" | "result" | "error" | "tool_use" | "tool_result";
  subtype?: string;
  message?: CliStreamMessage;
  model?: string;
  error?: string;
  is_partial?: boolean;
}

export interface TransportEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
  partial?: unknown;
  content?: unknown;
  message?: unknown;
  reason?: string;
  error?: unknown;
  toolCall?: unknown;
}

interface MutableTextBlock {
  type: "text";
  text: string;
}

interface MutableThinkingBlock {
  type: "thinking";
  thinking: string;
  thinkingSignature: string;
}

interface MutableToolBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

type MutableBlock = MutableTextBlock | MutableThinkingBlock | MutableToolBlock;

interface MutableAssistantOutput {
  role: "assistant";
  content: MutableBlock[];
  api: "anthropic-messages";
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: string;
  timestamp: number;
  responseId?: string;
  errorMessage?: string;
}

function createEmptyOutput(provider: string, model: string): MutableAssistantOutput {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider,
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** Anthropic stop_reason 문자열을 OpenClaw 내부 표기로 정규화. */
function mapStopReason(reason: string | undefined): string {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "toolUse";
    case "max_tokens":
      return "length";
    default:
      return reason || "stop";
  }
}

/**
 * 문자열로부터 JSONL 라인들을 비동기적으로 추출하는 헬퍼.
 * stdout 청크는 라인 경계에 정렬되어 있지 않을 수 있으므로 버퍼링한다.
 */
async function* iterStdoutLines(proc: ChildProcess): AsyncGenerator<string> {
  if (!proc.stdout) {
    throw new Error("CLI 프로세스에 stdout이 없습니다");
  }
  proc.stdout.setEncoding("utf8");

  const queue: string[] = [];
  let buffer = "";
  let done = false;
  let errored: Error | null = null;
  let resolveWaiter: (() => void) | null = null;

  const wake = () => {
    const r = resolveWaiter;
    resolveWaiter = null;
    r?.();
  };

  proc.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim().length > 0) queue.push(line);
      idx = buffer.indexOf("\n");
    }
    wake();
  });

  proc.stdout.on("end", () => {
    if (buffer.trim().length > 0) {
      queue.push(buffer);
      buffer = "";
    }
    done = true;
    wake();
  });

  proc.on("error", (err) => {
    errored = err instanceof Error ? err : new Error(String(err));
    done = true;
    wake();
  });

  proc.on("close", () => {
    done = true;
    wake();
  });

  while (true) {
    if (queue.length > 0) {
      yield queue.shift()!;
      continue;
    }
    if (done) {
      if (errored) throw errored;
      return;
    }
    await new Promise<void>((resolve) => {
      resolveWaiter = resolve;
    });
  }
}

/**
 * ChildProcess의 JSONL stdout을 파싱하여 transport 이벤트 제너레이터를 만든다.
 *
 * @param proc spawn된 claude CLI 프로세스
 * @param meta provider/model — start/done 이벤트의 partial 출력에 채워 넣음
 */
export async function* parseCliStream(
  proc: ChildProcess,
  meta: { provider: string; model: string },
): AsyncGenerator<TransportEvent> {
  const output = createEmptyOutput(meta.provider, meta.model);
  let startEmitted = false;

  // 텍스트/사고 블록의 마지막 길이를 기록해 델타만 추출한다.
  // partial 메시지는 누적 텍스트를 다시 보내므로 새로 추가된 부분만 emit해야 한다.
  const textLengths = new Map<number, number>();
  const thinkingLengths = new Map<number, number>();
  // tool_use 블록은 한 번만 start를 emit하기 위해 추적.
  const toolStarted = new Set<number>();

  const ensureStart = () => {
    if (!startEmitted) {
      startEmitted = true;
      return { type: "start", partial: output as unknown } satisfies TransportEvent;
    }
    return null;
  };

  try {
    for await (const line of iterStdoutLines(proc)) {
      let event: CliStreamEvent | null = null;
      try {
        event = JSON.parse(line) as CliStreamEvent;
      } catch {
        // 비JSON 줄(진행률 표시 등)은 무시.
        continue;
      }
      if (!event) continue;

      // system init 이벤트에서 model을 미리 알 수 있으면 갱신.
      if (event.type === "system") {
        const sysModel =
          event.model ||
          (event as { message?: { model?: string } }).message?.model;
        if (sysModel) output.model = sysModel;
        continue;
      }

      if (event.type === "error") {
        const startEv = ensureStart();
        if (startEv) yield startEv;
        const message = event.error || "claude CLI 실행 오류";
        output.stopReason = "error";
        output.errorMessage = message;
        yield { type: "error", reason: "error", error: { ...output } as unknown };
        return;
      }

      if (event.type === "assistant" && event.message) {
        const startEv = ensureStart();
        if (startEv) yield startEv;

        if (event.message.model) output.model = event.message.model;
        if (event.message.id) output.responseId = event.message.id;

        const blocks = event.message.content ?? [];
        for (let i = 0; i < blocks.length; i += 1) {
          const block = blocks[i];

          if (block.type === "text" && typeof block.text === "string") {
            // 누적 텍스트 — 새로 늘어난 부분만 델타로 emit.
            const prevLen = textLengths.get(i) ?? 0;
            if (prevLen === 0 && block.text.length === 0) {
              // 아직 비어있음 — 시작도 미루기.
              continue;
            }
            // 기존 블록이 없으면 push.
            while (output.content.length <= i) {
              output.content.push({ type: "text", text: "" });
            }
            // 현재 인덱스의 슬롯 타입이 text가 아니라면(이전이 다른 타입이었을 수 있음) 보정.
            const slot = output.content[i];
            if (slot.type !== "text") {
              continue;
            }
            if (prevLen === 0) {
              yield {
                type: "text_start",
                contentIndex: i,
                partial: output as unknown,
              };
            }
            const newText = block.text.slice(prevLen);
            if (newText.length > 0) {
              slot.text = block.text;
              textLengths.set(i, block.text.length);
              yield {
                type: "text_delta",
                contentIndex: i,
                delta: newText,
                partial: output as unknown,
              };
            }
            continue;
          }

          if (block.type === "thinking" && typeof block.thinking === "string") {
            const prevLen = thinkingLengths.get(i) ?? 0;
            if (prevLen === 0 && block.thinking.length === 0) {
              continue;
            }
            while (output.content.length <= i) {
              output.content.push({ type: "text", text: "" });
            }
            // 처음이면 thinking 블록으로 교체.
            if (prevLen === 0) {
              output.content[i] = {
                type: "thinking",
                thinking: "",
                thinkingSignature: "",
              };
              yield {
                type: "thinking_start",
                contentIndex: i,
                partial: output as unknown,
              };
            }
            const slot = output.content[i];
            if (slot.type !== "thinking") continue;
            const newThinking = block.thinking.slice(prevLen);
            if (newThinking.length > 0) {
              slot.thinking = block.thinking;
              thinkingLengths.set(i, block.thinking.length);
              yield {
                type: "thinking_delta",
                contentIndex: i,
                delta: newThinking,
                partial: output as unknown,
              };
            }
            continue;
          }

          if (block.type === "tool_use" && block.name) {
            if (toolStarted.has(i)) {
              continue;
            }
            toolStarted.add(i);
            while (output.content.length <= i) {
              output.content.push({ type: "text", text: "" });
            }
            const toolBlock: MutableToolBlock = {
              type: "toolCall",
              id: block.id ?? "",
              name: block.name,
              arguments: (block.input && typeof block.input === "object") ? block.input : {},
            };
            output.content[i] = toolBlock;
            yield {
              type: "toolcall_start",
              contentIndex: i,
              partial: output as unknown,
            };
          }
        }
        continue;
      }

      if (event.type === "result" && event.message) {
        const startEv = ensureStart();
        if (startEv) yield startEv;

        // 마지막 누적 텍스트/사고/툴을 끝낸다.
        for (let i = 0; i < output.content.length; i += 1) {
          const slot = output.content[i];
          if (slot.type === "text") {
            yield {
              type: "text_end",
              contentIndex: i,
              content: slot.text,
              partial: output as unknown,
            };
          } else if (slot.type === "thinking") {
            yield {
              type: "thinking_end",
              contentIndex: i,
              content: slot.thinking,
              partial: output as unknown,
            };
          } else if (slot.type === "toolCall") {
            yield {
              type: "toolcall_end",
              contentIndex: i,
              toolCall: slot as unknown,
              partial: output as unknown,
            };
          }
        }

        const usage = event.message.usage;
        if (usage) {
          output.usage.input = usage.input_tokens ?? 0;
          output.usage.output = usage.output_tokens ?? 0;
          output.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
          output.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
          output.usage.totalTokens =
            output.usage.input +
            output.usage.output +
            output.usage.cacheRead +
            output.usage.cacheWrite;
        }
        output.stopReason = mapStopReason(event.message.stop_reason);

        yield {
          type: "done",
          reason: output.stopReason,
          message: { ...output } as unknown,
        };
        return;
      }
    }

    // stdout이 result 없이 끝난 경우 — 정상 종료로 간주하고 done emit.
    const startEv = ensureStart();
    if (startEv) yield startEv;
    yield {
      type: "done",
      reason: output.stopReason,
      message: { ...output } as unknown,
    };
  } catch (err) {
    output.stopReason = "error";
    output.errorMessage = err instanceof Error ? err.message : String(err);
    yield { type: "error", reason: "error", error: { ...output } as unknown };
  }
}
