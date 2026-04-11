/**
 * Claude CLI의 `--output-format stream-json` JSONL 출력을 OpenClaw 내부
 * transport 이벤트로 변환하는 어댑터.
 *
 * 실제 claude CLI(2.1.x)는 Anthropic SDK의 SSE 이벤트를 그대로 감싼 JSONL을
 * 출력한다. 핵심 형태는 다음과 같다:
 *
 *   {"type":"system","subtype":"init", ...}                          // 무시
 *   {"type":"stream_event","event":{"type":"message_start", ...}}
 *   {"type":"stream_event","event":{"type":"content_block_start", ...}}
 *   {"type":"stream_event","event":{"type":"content_block_delta", ...}}
 *   {"type":"stream_event","event":{"type":"content_block_stop", ...}}
 *   {"type":"assistant","message":{ ... full snapshot ... }}         // 무시
 *   {"type":"stream_event","event":{"type":"message_delta", ...}}
 *   {"type":"stream_event","event":{"type":"message_stop"}}
 *   {"type":"rate_limit_event", ...}                                 // 무시
 *   {"type":"system","subtype":"hook_started"|"hook_response", ...}  // 무시
 *   {"type":"result","subtype":"success","result":"...","usage":{...}, ...}
 *
 * `stream_event.event.*`의 내부 페이로드는 anthropic-transport-stream.ts의
 * SDK 분기와 동일한 구조라 그쪽 처리 로직을 거의 그대로 옮겨 쓴다.
 * 최종 usage/stop_reason은 top-level `result` 이벤트에서도 보강한다.
 */

import type { ChildProcess } from "node:child_process";
import { parseStreamingJson } from "@mariozechner/pi-ai";

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
  index?: number;
}

interface MutableThinkingBlock {
  type: "thinking";
  thinking: string;
  thinkingSignature: string;
  redacted?: boolean;
  index?: number;
}

interface MutableToolBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
  partialJson?: string;
  index?: number;
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

function recomputeTotal(output: MutableAssistantOutput): void {
  output.usage.totalTokens =
    output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
}

/**
 * stdout 청크는 라인 경계에 정렬되어 있지 않으므로 버퍼링하면서
 * 한 줄씩 흘려보낸다.
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

  proc.on("error", (err: unknown) => {
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

interface CliJsonl {
  type?: string;
  subtype?: string;
  event?: { type?: string; [k: string]: unknown };
  message?: { id?: string; usage?: Record<string, unknown> };
  result?: string;
  stop_reason?: string;
  usage?: Record<string, unknown>;
  error?: string;
  [k: string]: unknown;
}

/**
 * ChildProcess의 JSONL stdout을 파싱해 transport 이벤트 제너레이터를 만든다.
 *
 * @param proc spawn된 claude CLI 프로세스
 * @param meta provider/model — start/done 이벤트의 partial 출력에 기록.
 */
export async function* parseCliStream(
  proc: ChildProcess,
  meta: { provider: string; model: string },
): AsyncGenerator<TransportEvent> {
  const output = createEmptyOutput(meta.provider, meta.model);
  const blocks = output.content;
  let startEmitted = false;
  let doneEmitted = false;

  const ensureStart = (): TransportEvent | null => {
    if (startEmitted) return null;
    startEmitted = true;
    return { type: "start", partial: output as unknown };
  };

  // 내부 SSE 이벤트(stream_event.event) 처리.
  // anthropic-transport-stream.ts의 SDK 분기와 동일한 분기 트리.
  function* handleSseEvent(event: Record<string, unknown>): Generator<TransportEvent> {
    const evType = typeof event.type === "string" ? event.type : "";

    if (evType === "message_start") {
      const message = event.message as
        | { id?: string; usage?: Record<string, unknown> }
        | undefined;
      const usage = message?.usage ?? {};
      if (typeof message?.id === "string") output.responseId = message.id;
      if (typeof usage.input_tokens === "number") output.usage.input = usage.input_tokens;
      if (typeof usage.output_tokens === "number") output.usage.output = usage.output_tokens;
      if (typeof usage.cache_read_input_tokens === "number") {
        output.usage.cacheRead = usage.cache_read_input_tokens;
      }
      if (typeof usage.cache_creation_input_tokens === "number") {
        output.usage.cacheWrite = usage.cache_creation_input_tokens;
      }
      recomputeTotal(output);
      return;
    }

    if (evType === "content_block_start") {
      const contentBlock = event.content_block as Record<string, unknown> | undefined;
      const index = typeof event.index === "number" ? event.index : -1;
      if (contentBlock?.type === "text") {
        const block: MutableTextBlock = { type: "text", text: "", index };
        blocks.push(block);
        yield {
          type: "text_start",
          contentIndex: blocks.length - 1,
          partial: output as unknown,
        };
        return;
      }
      if (contentBlock?.type === "thinking") {
        const block: MutableThinkingBlock = {
          type: "thinking",
          thinking: "",
          thinkingSignature: "",
          index,
        };
        blocks.push(block);
        yield {
          type: "thinking_start",
          contentIndex: blocks.length - 1,
          partial: output as unknown,
        };
        return;
      }
      if (contentBlock?.type === "redacted_thinking") {
        const block: MutableThinkingBlock = {
          type: "thinking",
          thinking: "[Reasoning redacted]",
          thinkingSignature: typeof contentBlock.data === "string" ? contentBlock.data : "",
          redacted: true,
          index,
        };
        blocks.push(block);
        yield {
          type: "thinking_start",
          contentIndex: blocks.length - 1,
          partial: output as unknown,
        };
        return;
      }
      if (contentBlock?.type === "tool_use") {
        const block: MutableToolBlock = {
          type: "toolCall",
          id: typeof contentBlock.id === "string" ? contentBlock.id : "",
          name: typeof contentBlock.name === "string" ? contentBlock.name : "",
          arguments:
            contentBlock.input && typeof contentBlock.input === "object"
              ? (contentBlock.input as Record<string, unknown>)
              : {},
          partialJson: "",
          index,
        };
        blocks.push(block);
        yield {
          type: "toolcall_start",
          contentIndex: blocks.length - 1,
          partial: output as unknown,
        };
      }
      return;
    }

    if (evType === "content_block_delta") {
      const idx = blocks.findIndex((b) => b.index === event.index);
      if (idx < 0) return;
      const block = blocks[idx];
      const delta = event.delta as Record<string, unknown> | undefined;

      if (
        block.type === "text" &&
        delta?.type === "text_delta" &&
        typeof delta.text === "string"
      ) {
        block.text += delta.text;
        yield {
          type: "text_delta",
          contentIndex: idx,
          delta: delta.text,
          partial: output as unknown,
        };
        return;
      }
      if (
        block.type === "thinking" &&
        delta?.type === "thinking_delta" &&
        typeof delta.thinking === "string"
      ) {
        block.thinking += delta.thinking;
        yield {
          type: "thinking_delta",
          contentIndex: idx,
          delta: delta.thinking,
          partial: output as unknown,
        };
        return;
      }
      if (
        block.type === "toolCall" &&
        delta?.type === "input_json_delta" &&
        typeof delta.partial_json === "string"
      ) {
        block.partialJson = `${block.partialJson ?? ""}${delta.partial_json}`;
        block.arguments = parseStreamingJson(block.partialJson);
        yield {
          type: "toolcall_delta",
          contentIndex: idx,
          delta: delta.partial_json,
          partial: output as unknown,
        };
        return;
      }
      if (
        block.type === "thinking" &&
        delta?.type === "signature_delta" &&
        typeof delta.signature === "string"
      ) {
        block.thinkingSignature = `${String(block.thinkingSignature ?? "")}${delta.signature}`;
      }
      return;
    }

    if (evType === "content_block_stop") {
      const idx = blocks.findIndex((b) => b.index === event.index);
      if (idx < 0) return;
      const block = blocks[idx];
      delete block.index;
      if (block.type === "text") {
        yield {
          type: "text_end",
          contentIndex: idx,
          content: block.text,
          partial: output as unknown,
        };
        return;
      }
      if (block.type === "thinking") {
        yield {
          type: "thinking_end",
          contentIndex: idx,
          content: block.thinking,
          partial: output as unknown,
        };
        return;
      }
      if (block.type === "toolCall") {
        if (typeof block.partialJson === "string" && block.partialJson.length > 0) {
          block.arguments = parseStreamingJson(block.partialJson);
        }
        delete block.partialJson;
        yield {
          type: "toolcall_end",
          contentIndex: idx,
          toolCall: block as unknown,
          partial: output as unknown,
        };
      }
      return;
    }

    if (evType === "message_delta") {
      const delta = event.delta as { stop_reason?: string } | undefined;
      const usage = event.usage as Record<string, unknown> | undefined;
      if (delta?.stop_reason) {
        output.stopReason = mapStopReason(delta.stop_reason);
      }
      if (typeof usage?.input_tokens === "number") output.usage.input = usage.input_tokens;
      if (typeof usage?.output_tokens === "number") output.usage.output = usage.output_tokens;
      if (typeof usage?.cache_read_input_tokens === "number") {
        output.usage.cacheRead = usage.cache_read_input_tokens;
      }
      if (typeof usage?.cache_creation_input_tokens === "number") {
        output.usage.cacheWrite = usage.cache_creation_input_tokens;
      }
      recomputeTotal(output);
      return;
    }

    // message_stop, ping 등은 별도 이벤트가 필요 없다.
  }

  try {
    for await (const line of iterStdoutLines(proc)) {
      let parsed: CliJsonl | null = null;
      try {
        parsed = JSON.parse(line) as CliJsonl;
      } catch {
        // 비JSON 줄(진행률 표시 등)은 무시.
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const topType = parsed.type;

      // system init/hook_*: 모델 정보만 슬쩍 갱신하고 패스.
      if (topType === "system") {
        const sysModel = (parsed as { model?: string }).model;
        if (typeof sysModel === "string" && sysModel.length > 0) {
          output.model = sysModel;
        }
        continue;
      }

      if (topType === "rate_limit_event" || topType === "assistant") {
        // assistant는 중간 스냅샷 — stream_event 시퀀스로 충분하므로 무시.
        continue;
      }

      if (topType === "error") {
        const startEv = ensureStart();
        if (startEv) yield startEv;
        const message =
          typeof parsed.error === "string" ? parsed.error : "claude CLI 실행 오류";
        output.stopReason = "error";
        output.errorMessage = message;
        doneEmitted = true;
        yield { type: "error", reason: "error", error: { ...output } as unknown };
        return;
      }

      if (topType === "stream_event" && parsed.event && typeof parsed.event === "object") {
        const startEv = ensureStart();
        if (startEv) yield startEv;
        for (const ev of handleSseEvent(parsed.event)) {
          yield ev;
        }
        continue;
      }

      if (topType === "result") {
        const startEv = ensureStart();
        if (startEv) yield startEv;

        // 일부 stream_event가 누락된 경우(예: 매우 짧은 응답)를 대비해
        // result.result 텍스트에서도 텍스트 블록을 보강한다.
        if (
          blocks.length === 0 &&
          typeof parsed.result === "string" &&
          parsed.result.length > 0
        ) {
          const block: MutableTextBlock = { type: "text", text: parsed.result };
          blocks.push(block);
          yield { type: "text_start", contentIndex: 0, partial: output as unknown };
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: parsed.result,
            partial: output as unknown,
          };
          yield {
            type: "text_end",
            contentIndex: 0,
            content: parsed.result,
            partial: output as unknown,
          };
        }

        // top-level usage가 더 정확한 최종값이므로 덮어쓴다.
        const usage = parsed.usage;
        if (usage && typeof usage === "object") {
          if (typeof usage.input_tokens === "number") output.usage.input = usage.input_tokens;
          if (typeof usage.output_tokens === "number") output.usage.output = usage.output_tokens;
          if (typeof usage.cache_read_input_tokens === "number") {
            output.usage.cacheRead = usage.cache_read_input_tokens;
          }
          if (typeof usage.cache_creation_input_tokens === "number") {
            output.usage.cacheWrite = usage.cache_creation_input_tokens;
          }
          recomputeTotal(output);
        }
        if (typeof parsed.stop_reason === "string") {
          output.stopReason = mapStopReason(parsed.stop_reason);
        }
        if (parsed.subtype === "error_during_execution" || parsed.is_error === true) {
          output.stopReason = "error";
          if (typeof parsed.error === "string") output.errorMessage = parsed.error;
        }

        doneEmitted = true;
        yield {
          type: "done",
          reason: output.stopReason,
          message: { ...output } as unknown,
        };
        return;
      }
    }

    // result 없이 stdout이 닫힌 경우 — 정상 종료로 간주하고 done emit.
    if (!doneEmitted) {
      const startEv = ensureStart();
      if (startEv) yield startEv;
      yield {
        type: "done",
        reason: output.stopReason,
        message: { ...output } as unknown,
      };
    }
  } catch (err) {
    if (!doneEmitted) {
      output.stopReason = "error";
      output.errorMessage = err instanceof Error ? err.message : String(err);
      yield { type: "error", reason: "error", error: { ...output } as unknown };
    }
  }
}
