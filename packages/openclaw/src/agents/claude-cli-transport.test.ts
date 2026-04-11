/**
 * Unit tests for claude-cli-transport.ts.
 *
 * spawn/execSync/fs는 모두 vi.mock으로 대체해 실제 프로세스 실행 없이 검증한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockExistsSync, mockReaddirSync, mockExecSync, mockSpawn } = vi.hoisted(() => ({
  mockExistsSync: vi.fn<(p: string) => boolean>(),
  mockReaddirSync: vi.fn<(p: string) => string[]>(),
  mockExecSync: vi.fn<(cmd: string, opts?: unknown) => string>(),
  mockSpawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readdirSync: mockReaddirSync,
}));

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
  spawn: mockSpawn,
}));

import {
  buildCliEnv,
  findClaudeBinary,
  isCliBinaryAvailable,
  spawnClaudeProcess,
} from "./claude-cli-transport.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReaddirSync.mockImplementation(() => {
    throw new Error("no dir");
  });
  mockExecSync.mockImplementation(() => {
    throw new Error("not found");
  });
  // 깨끗한 spawn stub: stdio 메서드와 이벤트 등록만 충분히 흉내냄.
  mockSpawn.mockImplementation(() => ({
    stdout: { on: vi.fn(), setEncoding: vi.fn() },
    stderr: { on: vi.fn() },
    once: vi.fn(),
    on: vi.fn(),
    kill: vi.fn(),
    killed: false,
    pid: 1234,
  }));
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("findClaudeBinary", () => {
  it("returns the explicit path when it exists", () => {
    mockExistsSync.mockImplementation((p: string) => p === "/explicit/claude");
    expect(findClaudeBinary("/explicit/claude")).toBe("/explicit/claude");
  });

  it("uses CLAUDE_CLI_PATH when explicit path is missing", () => {
    process.env.CLAUDE_CLI_PATH = "/env/claude";
    mockExistsSync.mockImplementation((p: string) => p === "/env/claude");
    expect(findClaudeBinary()).toBe("/env/claude");
  });

  it("falls back to `which claude` lookup", () => {
    delete process.env.CLAUDE_CLI_PATH;
    mockExecSync.mockImplementation((cmd) => {
      if (typeof cmd === "string" && cmd.includes("which")) return "/usr/local/bin/claude\n";
      throw new Error("nope");
    });
    mockExistsSync.mockImplementation((p: string) => p === "/usr/local/bin/claude");
    expect(findClaudeBinary()).toBe("/usr/local/bin/claude");
  });

  it("scans known global candidate paths", () => {
    delete process.env.CLAUDE_CLI_PATH;
    process.env.HOME = "/home/u";
    mockExistsSync.mockImplementation((p: string) => p === "/home/u/.npm-global/bin/claude");
    expect(findClaudeBinary()).toBe("/home/u/.npm-global/bin/claude");
  });

  it("falls back to the literal string 'claude' when nothing is found", () => {
    delete process.env.CLAUDE_CLI_PATH;
    process.env.HOME = "/home/u";
    expect(findClaudeBinary()).toBe("claude");
  });
});

describe("buildCliEnv", () => {
  it("prepends the binary directory to PATH", () => {
    process.env.PATH = "/usr/bin:/bin";
    const env = buildCliEnv("/opt/node22/bin/claude");
    expect(env.PATH).toBe(`/opt/node22/bin:/usr/bin:/bin`);
  });

  it("does not duplicate the directory if PATH already contains it", () => {
    process.env.PATH = "/opt/node22/bin:/usr/bin";
    const env = buildCliEnv("/opt/node22/bin/claude");
    expect(env.PATH).toBe("/opt/node22/bin:/usr/bin");
  });

  it("merges extra environment variables", () => {
    process.env.PATH = "/usr/bin";
    const env = buildCliEnv("/usr/bin/claude", { EXTRA_KEY: "value" });
    expect(env.EXTRA_KEY).toBe("value");
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("isCliBinaryAvailable", () => {
  it("returns true when --version succeeds", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation((cmd) => {
      if (typeof cmd === "string" && cmd.includes("--version")) return "claude 1.2.3";
      throw new Error("nope");
    });
    expect(isCliBinaryAvailable("/usr/local/bin/claude")).toBe(true);
  });

  it("returns false when execution fails", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(isCliBinaryAvailable("/usr/local/bin/claude")).toBe(false);
  });

  it("returns false when binary path does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(isCliBinaryAvailable("/usr/local/bin/claude")).toBe(false);
  });
});

describe("spawnClaudeProcess", () => {
  beforeEach(() => {
    mockExistsSync.mockImplementation((p: string) => p === "/usr/local/bin/claude");
    process.env.CLAUDE_CLI_PATH = "/usr/local/bin/claude";
  });

  it("includes -p, output-format, verbose by default and omits permission-mode", () => {
    delete process.env.OPENCLAW_CLI_PERMISSION_MODE;
    spawnClaudeProcess({ prompt: "hello" });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain("-p");
    expect(args).toContain("hello");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--include-partial-messages");
    expect(args).toContain("--verbose");
    // permission-mode는 opt-in이며 기본 호출에서는 절대 추가되지 않아야 한다.
    expect(args).not.toContain("--permission-mode");
  });

  it("adds --permission-mode when options.permissionMode is set", () => {
    delete process.env.OPENCLAW_CLI_PERMISSION_MODE;
    spawnClaudeProcess({ prompt: "p", options: { permissionMode: "acceptEdits" } });
    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain("--permission-mode");
    expect(args).toContain("acceptEdits");
  });

  it("uses OPENCLAW_CLI_PERMISSION_MODE env when option is omitted", () => {
    process.env.OPENCLAW_CLI_PERMISSION_MODE = "bypassPermissions";
    spawnClaudeProcess({ prompt: "p" });
    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain("--permission-mode");
    expect(args).toContain("bypassPermissions");
  });

  it("adds --model when modelId is set", () => {
    spawnClaudeProcess({ prompt: "p", modelId: "claude-sonnet-4-6" });
    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-6");
  });

  it("adds --append-system-prompt when systemPrompt is set", () => {
    spawnClaudeProcess({ prompt: "p", systemPrompt: "you are helpful" });
    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("you are helpful");
  });

  it("adds --allowedTools when tools are provided", () => {
    spawnClaudeProcess({ prompt: "p", tools: ["Read", "Bash"] });
    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Read,Bash");
  });

  it("uses --resume when isResume + sessionId provided", () => {
    spawnClaudeProcess({ prompt: "p", sessionId: "sess-1", isResume: true });
    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain("--resume");
    expect(args).toContain("sess-1");
    expect(args).not.toContain("--session-id");
  });

  it("uses --session-id when sessionId provided without isResume", () => {
    spawnClaudeProcess({ prompt: "p", sessionId: "sess-2" });
    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain("--session-id");
    expect(args).toContain("sess-2");
    expect(args).not.toContain("--resume");
  });
});
