/**
 * Unit tests for claude-cli-stream-adapter.ts.
 *
 * 가짜 ChildProcess(EventEmitter + stdout)로 JSONL 청크를 흘려 넣고
 * 제너레이터가 emit하는 transport 이벤트 시퀀스를 검증한다.
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

describe("parseCliStream", () => {
  it("converts a single text JSONL line into start + text_start + text_delta + text_end + done", async () => {
    const { proc, feed, end } = createProc();
    const promise = collect(
      parseCliStream(proc, { provider: "claude-cli", model: "claude-sonnet-4-6" }),
    );
    feed(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
        is_partial: true,
      }) + "\n",
    );
    feed(
      JSON.stringify({
        type: "result",
        message: {
          content: [{ type: "text", text: "Hello" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 1 },
        },
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

  it("emits only the new portion when partial text grows incrementally", async () => {
    const { proc, feed, end } = createProc();
    const promise = collect(
      parseCliStream(proc, { provider: "claude-cli", model: "m" }),
    );
    feed(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "He" }] },
        is_partial: true,
      }) + "\n",
    );
    feed(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
        is_partial: true,
      }) + "\n",
    );
    feed(
      JSON.stringify({
        type: "result",
        message: {
          content: [{ type: "text", text: "Hello" }],
          stop_reason: "end_turn",
        },
      }) + "\n",
    );
    end();
    const events = await promise;

    const deltas = events.filter((e) => e.type === "text_delta").map((e) => e.delta);
    expect(deltas).toEqual(["He", "llo"]);
  });

  it("handles thinking blocks with thinking_start + thinking_delta", async () => {
    const { proc, feed, end } = createProc();
    const promise = collect(parseCliStream(proc, { provider: "claude-cli", model: "m" }));
    feed(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "let me think" }] },
        is_partial: true,
      }) + "\n",
    );
    feed(
      JSON.stringify({
        type: "result",
        message: {
          content: [{ type: "thinking", thinking: "let me think" }],
          stop_reason: "end_turn",
        },
      }) + "\n",
    );
    end();
    const events = await promise;
    const types = events.map((e) => e.type);
    expect(types).toContain("thinking_start");
    expect(types).toContain("thinking_delta");
    expect(types).toContain("thinking_end");
  });

  it("emits toolcall_start for tool_use blocks", async () => {
    const { proc, feed, end } = createProc();
    const promise = collect(parseCliStream(proc, { provider: "claude-cli", model: "m" }));
    feed(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "call_1", name: "Read", input: { path: "/tmp" } },
          ],
        },
      }) + "\n",
    );
    feed(
      JSON.stringify({
        type: "result",
        message: {
          content: [
            { type: "tool_use", id: "call_1", name: "Read", input: { path: "/tmp" } },
          ],
          stop_reason: "tool_use",
        },
      }) + "\n",
    );
    end();
    const events = await promise;
    const types = events.map((e) => e.type);
    expect(types).toContain("toolcall_start");
    expect(types).toContain("toolcall_end");
    const done = events.find((e) => e.type === "done");
    expect(done?.reason).toBe("toolUse");
  });

  it("populates usage in the final done event", async () => {
    const { proc, feed, end } = createProc();
    const promise = collect(parseCliStream(proc, { provider: "claude-cli", model: "m" }));
    feed(
      JSON.stringify({
        type: "result",
        message: {
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 2 },
        },
      }) + "\n",
    );
    end();
    const events = await promise;
    const done = events.find((e) => e.type === "done");
    const message = done?.message as { usage: { input: number; output: number; cacheRead: number; totalTokens: number } };
    expect(message.usage.input).toBe(10);
    expect(message.usage.output).toBe(3);
    expect(message.usage.cacheRead).toBe(2);
    expect(message.usage.totalTokens).toBe(15);
  });

  it("ignores non-JSON lines", async () => {
    const { proc, feed, end } = createProc();
    const promise = collect(parseCliStream(proc, { provider: "claude-cli", model: "m" }));
    feed("progress: 50%\n");
    feed(
      JSON.stringify({
        type: "result",
        message: {
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        },
      }) + "\n",
    );
    end();
    const events = await promise;
    expect(events[events.length - 1].type).toBe("done");
  });

  it("handles JSONL chunks split across data events", async () => {
    const { proc, feed, end } = createProc();
    const promise = collect(parseCliStream(proc, { provider: "claude-cli", model: "m" }));
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hi" }] },
    });
    feed(line.slice(0, 10));
    feed(line.slice(10) + "\n");
    feed(
      JSON.stringify({
        type: "result",
        message: { content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn" },
      }) + "\n",
    );
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
