/**
 * Claude CLI 백엔드 transport.
 *
 * Anthropic API에 직접 HTTP 요청하는 대신 로컬 `claude` 바이너리를 spawn해
 * 구독제 인증으로 추론을 실행한다. AI Hub electron-app의 `claude-cli.ts`와
 * 동일한 탐색/환경 보강 전략을 따른다.
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/** Claude CLI spawn 시 전달하는 옵션. */
export interface CliTransportOptions {
  /** claude 바이너리 경로 (지정하면 탐색 단계 건너뜀). */
  binaryPath?: string;
  /** 작업 디렉터리. */
  cwd?: string;
  /** 추가 환경변수. */
  env?: Record<string, string>;
  /** 타임아웃 ms (기본: 300_000). */
  timeoutMs?: number;
  /** AbortSignal. */
  signal?: AbortSignal;
}

/** spawn 시 사용한 인자/환경 정보를 함께 반환한다. 테스트와 디버깅에서 활용. */
export interface SpawnedClaudeProcess {
  process: ChildProcess;
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * nvm/fnm/volta 등 버전 매니저의 bin 디렉터리에서 claude를 찾는다.
 * AI Hub claude-cli.ts와 동일한 탐색 순서.
 */
function findInVersionManagers(home: string): string | null {
  if (!home) return null;

  // nvm: ~/.nvm/versions/node/v*/bin/claude
  const nvmBase = process.env.NVM_DIR || path.join(home, ".nvm");
  const nvmVersions = path.join(nvmBase, "versions", "node");
  try {
    const dirs = readdirSync(nvmVersions);
    for (const d of dirs.reverse()) {
      const p = path.join(nvmVersions, d, "bin", "claude");
      if (existsSync(p)) return p;
    }
  } catch {
    // ignore
  }

  // fnm: ~/.local/share/fnm/node-versions/v*/installation/bin/claude
  const fnmBase = path.join(home, ".local", "share", "fnm", "node-versions");
  try {
    const dirs = readdirSync(fnmBase);
    for (const d of dirs.reverse()) {
      const p = path.join(fnmBase, d, "installation", "bin", "claude");
      if (existsSync(p)) return p;
    }
  } catch {
    // ignore
  }

  // volta: ~/.volta/bin/claude
  const voltaP = path.join(home, ".volta", "bin", "claude");
  if (existsSync(voltaP)) return voltaP;

  return null;
}

/**
 * claude 바이너리 경로를 탐색한다.
 * 탐색 순서:
 *   1) 명시적 인자
 *   2) `CLAUDE_CLI_PATH` 환경변수
 *   3) `which claude`
 *   4) 알려진 글로벌 경로 후보
 *   5) nvm/fnm/volta
 *   6) 마지막 폴백: 문자열 "claude" (PATH 의존)
 */
export function findClaudeBinary(explicitPath?: string): string {
  if (explicitPath && existsSync(explicitPath)) return explicitPath;

  const envPath = process.env.CLAUDE_CLI_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  try {
    const p = execSync("which claude", { encoding: "utf8", timeout: 3000 }).trim();
    if (p && existsSync(p)) return p;
  } catch {
    // ignore
  }

  const home = process.env.HOME || "";
  const candidates = [
    "/opt/node22/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
    `${home}/.npm-global/bin/claude`,
    `${home}/.local/bin/claude`,
    `${home}/.bun/bin/claude`,
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  const vmPath = findInVersionManagers(home);
  if (vmPath) return vmPath;

  return "claude";
}

/**
 * claude 바이너리 실행에 필요한 환경변수를 생성한다.
 * cli.js 의 shebang(#!/usr/bin/env node)이 node를 찾을 수 있도록
 * 바이너리 디렉터리를 PATH 앞에 추가한다.
 *
 * 보안: API 키는 의도적으로 전달하지 않는다. claude CLI는 `~/.claude/`의
 * 구독 인증을 사용한다.
 */
export function buildCliEnv(
  binaryPath: string,
  extra?: Record<string, string>,
): NodeJS.ProcessEnv {
  const binDir = path.dirname(binaryPath);
  const currentPath = process.env.PATH || "";
  const newPath = currentPath
    .split(path.delimiter)
    .includes(binDir)
    ? currentPath
    : `${binDir}${path.delimiter}${currentPath}`;
  return { ...process.env, PATH: newPath, ...(extra ?? {}) };
}

/**
 * CLI 모드 사용 가능 여부를 확인한다.
 * 바이너리가 발견되고 `claude --version`이 성공해야 true.
 */
export function isCliBinaryAvailable(binaryPath?: string): boolean {
  try {
    const bin = binaryPath ?? findClaudeBinary();
    if (bin !== "claude" && !existsSync(bin)) return false;
    execSync(`${JSON.stringify(bin)} --version`, {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * claude CLI를 spawn하고 JSONL stdout을 출력하는 ChildProcess를 반환한다.
 *
 * 인자 구성:
 *   claude -p {prompt}
 *     --output-format stream-json
 *     --include-partial-messages
 *     --verbose
 *     --permission-mode bypassPermissions
 *     [--model {modelId}]
 *     [--allowedTools Tool1,Tool2]
 *     [--append-system-prompt {system}]
 *     [--resume {sessionId}] | [--session-id {sessionId}]
 */
export function spawnClaudeProcess(params: {
  prompt: string;
  modelId?: string;
  systemPrompt?: string;
  tools?: string[];
  sessionId?: string;
  isResume?: boolean;
  options?: CliTransportOptions;
}): SpawnedClaudeProcess {
  const binary = findClaudeBinary(params.options?.binaryPath);
  const env = buildCliEnv(binary, params.options?.env);

  const args: string[] = [];

  if (params.isResume && params.sessionId) {
    args.push("-p", params.prompt, "--resume", params.sessionId);
  } else {
    args.push("-p", params.prompt);
  }

  args.push(
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
  );

  if (params.modelId) {
    args.push("--model", params.modelId);
  }

  if (params.systemPrompt) {
    args.push("--append-system-prompt", params.systemPrompt);
  }

  if (params.tools && params.tools.length > 0) {
    args.push("--allowedTools", params.tools.join(","));
  }

  if (params.sessionId && !params.isResume) {
    args.push("--session-id", params.sessionId);
  }

  args.push("--permission-mode", "bypassPermissions");

  const proc = spawn(binary, args, {
    cwd: params.options?.cwd || process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // 타임아웃 처리: 지정된 경우 SIGTERM 후 SIGKILL.
  const timeoutMs = params.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (timeoutMs > 0) {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      // 5초 후에도 살아있으면 강제 종료.
      setTimeout(() => {
        try {
          if (!proc.killed) proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 5000).unref();
    }, timeoutMs);
    timer.unref();
    proc.once("close", () => clearTimeout(timer));
  }

  // AbortSignal 연동.
  const signal = params.options?.signal;
  if (signal) {
    if (signal.aborted) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    } else {
      const onAbort = () => {
        try {
          proc.kill("SIGTERM");
        } catch {
          // ignore
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      proc.once("close", () => signal.removeEventListener("abort", onAbort));
    }
  }

  return { process: proc, binary, args, env };
}
