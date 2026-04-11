/**
 * Unit tests for claude-cli-stream-adapter.ts.
 *
 * 가짜 ChildProcess(EventEmitter + stdout)로 실제 claude CLI 2.1.x가 출력하는
 * 형태의 JSONL을 흘려 넣고 transport 이벤트 시퀀스를 검증한다.
 */
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseCliStream, type TransportEvent } from "./claude-cli-stream-adapter.js";

class FakeStdout extends EventEmitter {
  setEncoding(_enc: string): void {}
}

class FakeProcess extends EventEmitter {
  stdout = new FakeStdout();
}

function createProc(): {
  proc: ChildProcess;
  feed: (chunk: string) => void;
  end: () => void;
} {
  const fake = new FakeProcess();
  return {
    proc: fake as unknown as ChildProcess,
    feed: (chunk: string) => {
      fake.stdout.emit("data", chunk);
    },
    end: () => {
      fake.stdout.emit("end");
      fake.emit("close");
    },
  };
}

async function collect(
  gen: AsyncGenerator<TransportEvent>,
): Promise<TransportEvent[]> {
  const events: TransportEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

/** 실제 CLI 출력에서 채록한 stream_event 라인들을 만드는 헬퍼. */
function streamEvent(event: Record<string, unknown>): string {
  return JSON.stringify({ type: "stream_event", event }) + "\n";
}

describe("parseCliStream", () => {
  it("converts SSE-style stream_event lines into start + text_start + text_delta + text_end + done", async () => {
    const { proc, feed, end } = createProc();
    const promise = collect(
      parseCliStream(proc, { provider: "claude-cli", model: "claude-sonnet-4-6" }),
    );

    feed(JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-4-6" }) + "\n");
    feed(
      streamEvent({
        type: "message_start",
        message: { id: "msg_1", usage: { input_tokens: 3, output_tokens: 1 } },
      }),
    );
    feed(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    feed(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      }),
    );
    feed(streamEvent({ type: "content_block_stop", index: 0 }));
    feed(
      streamEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 3, output_tokens: 4 },
      }),
    );
    feed(streamEvent({ type: "message_stop" }));
    feed(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Hello",
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 11989 },
      }) + "\n",
    );
    end();
    const events = await promise;

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types).toContain("text_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("text_end");
    expect(types[types.length - 1]).toBe("done");

    const delta = events.find((e) => e.type === "text_delta");
    expect(delta?.delta).toBe("Hello");
  });

  it("emits each text_delta chunk separately", async () => {
    const { proc, feed, end } = createProc();
    const promise = collect(parseCliStream(proc, { provider: "claude-cli", model: "m" }));
    feed(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    feed(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "He" } }));
    feed(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "llo" } }));
    feed(streamEvent({ type: "content_block_stop", index: 0 }));
    feed(JSON.stringify({ type: "result", subtype: "success", result: "Hello", stop_reason: "end_turn" }) + "\n");
    end();
    const events = await promise;
    const deltas = events.filter((e) => e.type === "text_delta").map((e) => e.delta);
    expect(deltas).toEqual(["He", "llo"]);
  });

  it("handles thinking blocks with thinking_start + thinking_delta + thinking_end", async () => {
    const { proc, feed, end } = createProc();
    const promise = collect(parseCliStream(proc, { provider: "claude-cli", model: "m" }));
    feed(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
    );
    feed(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "let me think" },
      }),
    );
    feed(streamEvent({ type: "content_block_stop", index: 0 }));
    feed(JSON.stringify({ type: "result", subtype: "success", result: "", stop_reason: "end_turn" }) + "\n");
    end();
    const events = await promise;
    const types = events.map((e) => e.type);
    expect(types).toContain("thinking_start");
    expect(types).toContain("thinking_delta");
    expect(types).toContain("thinking_end");
  });

  it("emits toolcall_start/end for tool_use blocks", async () => {
    const { proc, feed, end } = createProc();
    const promise = collect(parseCliStream(proc, { provider: "claude-cli", model: "m" }));
    feed(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call_1", name: "Read", input: {} },
      }),
    );
    feed(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"path":"/tmp"}' },
      }),
    );
    feed(streamEvent({ type: "content_block_stop", index: 0 }));
    feed(
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "",
        stop_reason: "tool_use",
      }) + "\n",
    );
    end();
    const events = await promise;
    const types = events.map((e) => e.type);
    expect(types).toContain("toolcall_start");
    expect(types).toContain("toolcall_delta");
    expect(types).toContain("toolcall_end");
    const done = events.find((e) => e.type === "done");
    expect(done?.reason).toBe("toolUse");
  });

  it("populates usage in the final done event from top-level result", async () => {
    const { proc, feed, end } = createProc();
    const promise = collect(parseCliStream(proc, { provider: "claude-cli", model: "m" }));
    feed(
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "ok",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
      }) + "\n",
    );
    end();
    const events = await promise;
    const done = events.find((e) => e.type === "done");
    const message = done?.message as {
      usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
    };
    expect(message.usage.input).toBe(10);
    expect(message.usage.output).toBe(3);
    expect(message.usage.cacheRead).toBe(2);
    expect(message.usage.cacheWrite).toBe(1);
    expect(message.usage.totalTokens).toBe(16);
  });

  it("synthesizes a text block from result.result when stream_events are missing", async () => {
    const { proc, feed, end } = createProc();
    const promise = collect(parseCliStream(proc, { provider: "claude-cli", model: "m" }));
    feed(
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "fallback text",
        stop_reason: "end_turn",
      }) + "\n",
    );
    end();
    const events = await promise;
    const delta = events.find((e) => e.type === "text_delta");
    expect(delta?.delta).toBe("fallback text");
    const end_ = events.find((e) => e.type === "text_end");
    expect(end_?.content).toBe("fallback text");
  });

  it("ignores rate_limit_event, hook_started, hook_response, and assistant snapshots", async () => {
    const { proc, feed, end } = createProc();
    const promise = collect(parseCliStream(proc, { provider: "claude-cli", model: "m" }));
    feed(JSON.stringify({ type: "rate_limit_event", rate_limit_info: {} }) + "\n");
    feed(JSON.stringify({ type: "system", subtype: "hook_started" }) + "\n");
    feed(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ignore me" }] } }) + "\n");
    feed(JSON.stringify({ type: "system", subtype: "hook_response", outcome: "success" }) + "\n");
    feed(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    feed(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "real" } }));
    feed(streamEvent({ type: "content_block_stop", index: 0 }));
    feed(JSON.stringify({ type: "result", subtype: "success", result: "real", stop_reason: "end_turn" }) + "\n");
    end();
    const events = await promise;
    const deltas = events.filter((e) => e.type === "text_delta").map((e) => e.delta);
    expect(deltas).toEqual(["real"]);
  });

  it("ignores non-JSON lines", async () => {
    const { proc, feed, end } = createProc();
    const promise = collect(parseCliStream(proc, { provider: "claude-cli", model: "m" }));
    feed("progress: 50%\n");
    feed(JSON.stringify({ type: "result", subtype: "success", result: "ok", stop_reason: "end_turn" }) + "\n");
    end();
    const events = await promise;
    expect(events[events.length - 1].type).toBe("done");
  });

  it("handles JSONL chunks split across data events", async () => {
    const { proc, feed, end } = createProc();
    const promise = collect(parseCliStream(proc, { provider: "claude-cli", model: "m" }));
    const line = streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hi" },
    });
    feed(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    feed(line.slice(0, 20));
    feed(line.slice(20));
    feed(streamEvent({ type: "content_block_stop", index: 0 }));
    feed(JSON.stringify({ type: "result", subtype: "success", result: "Hi", stop_reason: "end_turn" }) + "\n");
    end();
    const events = await promise;
    const delta = events.find((e) => e.type === "text_delta");
    expect(delta?.delta).toBe("Hi");
  });

  it("emits an error event for type=error CLI events", async () => {
    const { proc, feed, end } = createProc();
    const promise = collect(parseCliStream(proc, { provider: "claude-cli", model: "m" }));
    feed(JSON.stringify({ type: "error", error: "auth failure" }) + "\n");
    end();
    const events = await promise;
    const errEv = events.find((e) => e.type === "error");
    expect(errEv).toBeTruthy();
    const errPayload = errEv?.error as { errorMessage: string; stopReason: string };
    expect(errPayload.errorMessage).toBe("auth failure");
    expect(errPayload.stopReason).toBe("error");
  });

  it("emits a done event when stdout closes without a result", async () => {
    const { proc, end } = createProc();
    const promise = collect(parseCliStream(proc, { provider: "claude-cli", model: "m" }));
    end();
    const events = await promise;
    expect(events[0].type).toBe("start");
    expect(events[events.length - 1].type).toBe("done");
  });
});
