# OpenClaw Claude CLI 백엔드 전환 명세서

> **목적**: OpenClaw이 Anthropic API를 직접 호출하는 대신, AI Hub c3와 동일하게 로컬 `claude` CLI 바이너리를 spawn하여 구독제 인증으로 추론을 실행하도록 전환한다.
>
> **작성일**: 2026-04-12

---

## 1. 배경과 동기

### 1.1 현재 문제

현재 OpenClaw의 추론 경로는 `@anthropic-ai/sdk`를 통해 **Anthropic API에 직접 HTTP 요청**을 보낸다.

```
사용자 → "내일 아침 10시에 뉴스 분석해줘"
       → AI Hub 미션 오케스트레이터 → OpenClaw Gateway
       → anthropic-transport-stream.ts
       → new Anthropic({ apiKey }) → client.messages.stream()
       → Anthropic API (https://api.anthropic.com/v1/messages)
       → ❌ 500 에러 (setup-token 폐기됨)
```

**구체적 문제점:**

1. **인증 수단 폐기**: OpenClaw은 `sk-ant-oat01-*` 형식의 setup-token 사용. Anthropic이 이 인증 방식을 폐기 → Gateway 500 에러
2. **비용 모델 불일치**: API 직접 호출은 **토큰당 과금** (사용한 만큼 비용 발생). setup-token, API key, OAuth 모두 마찬가지
3. **이중 인증 관리**: 사용자가 `claude auth login`(구독 인증)과 `ANTHROPIC_API_KEY`(API 인증)을 별도로 관리해야 함

| 인증 방식 | 비용 모델 | 현재 상태 |
|-----------|-----------|-----------|
| setup-token (`sk-ant-oat01-*`) | API 과금 (토큰당) | ❌ **폐기됨** |
| API key (`sk-ant-api-*`) | API 과금 (토큰당) | ⚠️ 유효하지만 과금 발생 |
| OAuth token | API 과금 (토큰당) | ⚠️ 유효하지만 과금 발생 |
| `claude` CLI 바이너리 | **구독제** (Pro/Max 정액) | ✅ AI Hub c3에서 사용 중 |

### 1.2 목표 상태

AI Hub의 c3가 이미 사용하는 방식과 동일하게, OpenClaw도 로컬 `claude` 바이너리를 프로세스로 spawn한다.

```
사용자 → "내일 아침 10시에 뉴스 분석해줘"
       → AI Hub 미션 오케스트레이터 → OpenClaw Gateway
       → claude-cli-transport.ts (신규)
       → spawn('claude', ['-p', ...])
       → claude 바이너리 (로컬 구독 인증)
       → ✅ 응답 수신 → 스트리밍 출력
```

### 1.3 선택의 이유

| 방안 | 장점 | 단점 |
|------|------|------|
| **A. claude CLI spawn (채택)** | 구독제 무과금, c3와 동일 패턴, 인증 자동 | 프로세스 오버헤드, 동시성 제한 |
| B. API key로 교체 | 코드 변경 최소 | 토큰당 과금 지속 |
| C. OAuth 마이그레이션 | Anthropic 공식 권장 | 여전히 API 과금, 복잡한 OAuth 플로우 |

**A를 채택하는 이유**: 토큰 기반 인증은 종류와 상관없이 전부 API 과금. 로컬 CLI spawn만이 구독제(Pro/Max) 인증을 활용할 수 있는 유일한 방법.

---

## 2. 현재 상태 분석

### 2.1 관련 파일 맵

#### AI Hub electron-app (c3 참고 구현)

| 파일 | 역할 |
|------|------|
| `packages/electron-app/src/lib/claude-cli.ts` | claude 바이너리 탐색 + 환경변수 설정 |
| `packages/electron-app/src/app/api/claude/[agentId]/route.ts` | `spawn()` 기반 스트리밍 실행 |
| `packages/electron-app/src/lib/mission-runner.ts` | `execFileAsync()` 기반 배치 실행 |
| `packages/electron-app/src/lib/openclaw-executor.ts` | OpenClaw CLI/Gateway 폴백 실행 |
| `packages/electron-app/src/lib/openclaw-client.ts` | Gateway HTTP 클라이언트 |
| `packages/electron-app/src/lib/openclaw-config.ts` | OpenClaw 설정 파일 관리 |
| `packages/electron-app/src/lib/gateway-manager.ts` | Gateway 프로세스 관리 |

#### OpenClaw (변경 대상)

| 파일 | 역할 |
|------|------|
| `packages/openclaw/src/agents/anthropic-transport-stream.ts` | **핵심** — SDK로 Anthropic API 스트리밍 호출 (~865줄) |
| `packages/openclaw/src/agents/anthropic-vertex-stream.ts` | Vertex AI 경로 (GCP 전용, 변경 불필요) |
| `packages/openclaw/extensions/anthropic/register.runtime.ts` | 프로바이더 등록 + 인증 방법 3가지 |
| `packages/openclaw/extensions/anthropic/cli-backend.ts` | CLI 백엔드 플러그인 **설정 정의** (실행 코드 아님) |
| `packages/openclaw/extensions/anthropic/cli-shared.ts` | CLI 공유 상수 (모델 별칭, 인자) |
| `packages/openclaw/.env.example` | 환경변수 예시 (`ANTHROPIC_API_KEY` 등) |

### 2.2 현재 데이터 흐름

#### c3 (AI Hub) — 이미 CLI spawn 방식

```
POST /api/claude/{agentId}
  │
  ├─ route.ts:75  runClaude()
  │    ├─ claude-cli.ts:76  CLAUDE_CLI (바이너리 경로)
  │    ├─ claude-cli.ts:83  CLAUDE_ENV (PATH 보강 환경변수)
  │    ├─ spawn(CLAUDE_CLI, ['-p', prompt, ...toolArgs, ...modelArgs])
  │    │    └─ cwd: 워크스페이스 경로
  │    │    └─ env: CLAUDE_ENV (API 키 없음!)
  │    │    └─ stdio: ['ignore', 'pipe', 'pipe']
  │    ├─ proc.stdout.on('data') → ReadableStream에 enqueue
  │    └─ proc.on('close') → 세션 마킹, 로그 저장
  │
  └─ Response(stream, { Content-Type: 'text/plain' })
```

#### OpenClaw Gateway — 현재 API 직접 호출 방식

```
OpenClaw Gateway (/v1/chat/completions)
  │
  ├─ anthropic-transport-stream.ts:595  createAnthropicMessagesTransportStreamFn()
  │    ├─ :612  apiKey = getEnvApiKey(model.provider)  ← setup-token 또는 API key
  │    ├─ :617  createAnthropicTransportClient({ apiKey })
  │    │    └─ :405  new Anthropic({ apiKey, authToken, baseURL })  ← SDK 인스턴스
  │    ├─ :623  buildAnthropicParams(model, context, ...)  ← 요청 파라미터 조립
  │    │    └─ :490  { model: model.id, messages, system, tools, thinking }
  │    ├─ :628  client.messages.stream({ ...params })  ← ⚠️ API 직접 호출
  │    └─ :634  for await (event of stream)  ← 스트림 이벤트 처리
  │         ├─ message_start → usage 집계
  │         ├─ content_block_start → text/thinking/tool_use 블록 시작
  │         ├─ content_block_delta → 텍스트 청크 방출
  │         └─ message_delta → stop_reason 처리
  │
  └─ OpenAI 호환 SSE 응답
```

#### 미션 오케스트레이터 — OpenClaw 에이전트 실행 흐름

```
POST /api/missions/{id}/run
  │
  ├─ executor === 'openclaw'일 때:
  │    └─ openclaw-executor.ts:150  agentRun()
  │         ├─ isGatewayReady() → true:
  │         │    └─ agentRunViaGateway()  → Gateway HTTP → ⚠️ SDK → API
  │         └─ isGatewayReady() → false:
  │              └─ agentRunViaCli()  → openclaw agent -m ...  → ⚠️ 역시 SDK → API
  │
  ├─ executor === 'c3'일 때:
  │    └─ mission-runner.ts:108  callClaude()
  │         └─ execFileAsync(CLAUDE_CLI, ['-p', prompt, ...])  → ✅ CLI spawn
  │
  └─ 결과 DB 저장 + 통합 문서 생성
```

**핵심 문제**: `executor === 'openclaw'` 경로는 Gateway든 직접 CLI든 결국 `anthropic-transport-stream.ts`의 SDK 호출로 귀결. API 과금이 발생하는 구간.

### 2.3 현재 타입/인터페이스

#### c3 claude-cli.ts 익스포트

```typescript
// packages/electron-app/src/lib/claude-cli.ts

export const CLAUDE_CLI: string;          // resolve()로 탐색된 바이너리 절대경로
export const CLAUDE_ENV: NodeJS.ProcessEnv; // PATH 보강된 환경변수
export function claudeSpawnError(e: any): string; // ENOENT 에러 → 사용자 메시지
```

#### openclaw-executor.ts 타입

```typescript
// packages/electron-app/src/lib/openclaw-executor.ts

export interface AgentRunParams {
  message: string;
  agent?: string;
  thinking?: string;
  model?: string;
  timeout?: number;     // seconds (default 300)
  sessionId?: string;
  deliver?: boolean;
  channel?: string;
  to?: string;
}

export interface AgentResult {
  ok: boolean;
  output?: string;
  error?: string;
}
```

#### OpenClaw transport 핵심 타입

```typescript
// packages/openclaw/src/agents/anthropic-transport-stream.ts

type AnthropicTransportModel = Model<"anthropic-messages"> & {
  headers?: Record<string, string>;
  provider: string;
};

type TransportContentBlock =
  | { type: "text"; text: string; index?: number }
  | { type: "thinking"; thinking: string; thinkingSignature: string; redacted?: boolean; index?: number }
  | { type: "toolCall"; id: string; name: string; arguments: unknown; partialJson?: string; index?: number };

type MutableAssistantOutput = {
  role: "assistant";
  content: Array<TransportContentBlock>;
  api: "anthropic-messages";
  provider: string;
  model: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
           cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } };
  stopReason: string;
  timestamp: number;
  responseId?: string;
  errorMessage?: string;
};
```

### 2.4 현재 API 엔드포인트

| 엔드포인트 | 메서드 | 역할 | 실행 경로 |
|-----------|--------|------|-----------|
| `/api/claude/{agentId}` | POST | c3 에이전트 실행 | `spawn(CLAUDE_CLI)` ✅ |
| `/api/missions/{id}/run` | POST | 미션 SSE 실행 | c3 또는 OpenClaw |
| `/api/openclaw/gateway` | GET | Gateway 상태 | HTTP 헬스체크 |
| `/api/openclaw/config` | GET/POST | OpenClaw 설정 | 파일 읽기/쓰기 |
| Gateway `/v1/chat/completions` | POST | OpenClaw 추론 | ⚠️ SDK → API |
| Gateway `/health` | GET | 헬스체크 | HTTP |
| Gateway `/ready` | GET | 준비 상태 | HTTP |

---

## 3. 설계

### 3.1 전체 흐름

변경 후 OpenClaw이 claude CLI를 사용하는 흐름:

```
┌─────────────────────────────────────────────────────────────────────┐
│ AI Hub electron-app                                                 │
│                                                                     │
│  POST /api/missions/{id}/run                                        │
│    ↓                                                                │
│  executor === 'openclaw'                                            │
│    ↓                                                                │
│  openclaw-executor.ts: agentRun()                                   │
│    ├─ Gateway ready → agentRunViaGateway()                          │
│    │    ↓                                                           │
│    │  ┌─────────────────────────────────────────────┐               │
│    │  │ OpenClaw Gateway (openclaw.json 설정에 의해) │               │
│    │  │                                             │               │
│    │  │ anthropic-transport-stream.ts                │               │
│    │  │   ↓ (CLI 모드 감지)                          │               │
│    │  │ claude-cli-transport.ts (신규)               │               │
│    │  │   ↓                                         │               │
│    │  │ spawn('claude', ['-p', ...])                │               │
│    │  │   → stdout 스트리밍 → JSONL 파싱             │               │
│    │  │   → TransportEvent 변환 → SSE 응답           │               │
│    │  └─────────────────────────────────────────────┘               │
│    │                                                                │
│    └─ Gateway not ready → agentRunViaCli()                          │
│         ↓                                                           │
│       spawn(CLAUDE_CLI, ['-p', message])  ← c3 직접 폴백            │
│         → stdout → 결과 반환                                         │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 파일 변경 목록

```
packages/openclaw/
├── src/agents/
│   ├── claude-cli-transport.ts          # [신규] CLI spawn 기반 transport 구현
│   ├── claude-cli-stream-adapter.ts     # [신규] JSONL → TransportEvent 변환기
│   └── anthropic-transport-stream.ts    # [수정] CLI 모드 분기 추가
├── extensions/anthropic/
│   ├── register.runtime.ts              # [수정] CLI 백엔드 기본값 전환
│   └── cli-backend.ts                   # (참고만, 직접 수정 불필요)
└── .env.example                         # [수정] CLAUDE_CLI_PATH 추가

packages/electron-app/
├── src/lib/
│   ├── openclaw-executor.ts             # [수정] CLI 직접 폴백 시 claude 바이너리 사용
│   └── gateway-manager.ts              # [수정] CLAUDE_CLI_PATH 환경변수 전달
└── src/__tests__/
    └── openclaw-cli-transport.test.ts   # [신규] CLI transport 테스트
```

### 3.3 타입 정의

```typescript
// packages/openclaw/src/agents/claude-cli-transport.ts

/** Claude CLI spawn 시 전달하는 옵션 */
export interface CliTransportOptions {
  /** claude 바이너리 경로 (기본: PATH에서 탐색) */
  binaryPath?: string;
  /** 작업 디렉터리 */
  cwd?: string;
  /** 추가 환경변수 */
  env?: Record<string, string>;
  /** 타임아웃 ms (기본: 300_000) */
  timeoutMs?: number;
  /** AbortSignal */
  signal?: AbortSignal;
}

/** CLI JSONL 출력의 단일 이벤트 */
export interface CliStreamEvent {
  type: 'assistant' | 'result' | 'error' | 'tool_use' | 'tool_result';
  message?: {
    content: Array<{
      type: 'text' | 'tool_use' | 'tool_result';
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
    model?: string;
    stop_reason?: string;
    usage?: { input_tokens: number; output_tokens: number };
  };
  error?: string;
  /** 부분 메시지 여부 (--include-partial-messages) */
  is_partial?: boolean;
}
```

---

## 4. 상세 구현

### 4.1 `claude-cli-transport.ts` — CLI spawn 기반 Transport (신규)

```typescript
// packages/openclaw/src/agents/claude-cli-transport.ts

import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import type { CliTransportOptions, CliStreamEvent } from "./claude-cli-stream-adapter.js";

/**
 * claude 바이너리 경로를 탐색한다.
 * c3의 claude-cli.ts와 동일한 탐색 순서를 따른다.
 */
export function findClaudeBinary(explicitPath?: string): string {
  // 1) 명시적 경로
  if (explicitPath && existsSync(explicitPath)) return explicitPath;

  // 2) 환경변수
  const envPath = process.env.CLAUDE_CLI_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  // 3) which claude
  try {
    const p = execSync("which claude", { encoding: "utf8", timeout: 3000 }).trim();
    if (p && existsSync(p)) return p;
  } catch {}

  // 4) 알려진 글로벌 경로
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

  // 5) nvm/fnm/volta 탐색
  const vmPath = findInVersionManagers(home);
  if (vmPath) return vmPath;

  // 6) 최후 폴백
  return "claude";
}

function findInVersionManagers(home: string): string | null {
  // nvm
  const nvmBase = process.env.NVM_DIR || path.join(home, ".nvm");
  try {
    const dirs = require("fs").readdirSync(path.join(nvmBase, "versions", "node"));
    for (const d of (dirs as string[]).reverse()) {
      const p = path.join(nvmBase, "versions", "node", d, "bin", "claude");
      if (existsSync(p)) return p;
    }
  } catch {}

  // fnm
  try {
    const fnmBase = path.join(home, ".local", "share", "fnm", "node-versions");
    const dirs = require("fs").readdirSync(fnmBase);
    for (const d of (dirs as string[]).reverse()) {
      const p = path.join(fnmBase, d, "installation", "bin", "claude");
      if (existsSync(p)) return p;
    }
  } catch {}

  // volta
  const voltaP = path.join(home, ".volta", "bin", "claude");
  if (existsSync(voltaP)) return voltaP;

  return null;
}

/**
 * claude 바이너리 실행에 필요한 환경변수를 생성한다.
 * shebang의 node를 찾을 수 있도록 바이너리 디렉터리를 PATH에 추가.
 */
export function buildCliEnv(binaryPath: string, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const binDir = path.dirname(binaryPath);
  const currentPath = process.env.PATH || "";
  const newPath = currentPath.includes(binDir) ? currentPath : `${binDir}:${currentPath}`;
  return { ...process.env, PATH: newPath, ...extra };
}

/** CLI 모드 사용 가능 여부 확인 (바이너리 존재 + 인증 상태) */
export function isCliBinaryAvailable(binaryPath?: string): boolean {
  try {
    const bin = binaryPath || findClaudeBinary();
    execSync(`${bin} --version`, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * claude CLI를 spawn하고 JSONL stdout 스트림을 반환한다.
 *
 * 인자 구성:
 *   claude -p {prompt}
 *     --output-format stream-json
 *     --include-partial-messages
 *     --verbose
 *     --model {modelId}
 *     [--allowedTools Tool1,Tool2]
 *     [--append-system-prompt {system}]
 *     [--continue]
 *     [--session-id {id}]
 */
export function spawnClaudeProcess(params: {
  prompt: string;
  modelId?: string;
  systemPrompt?: string;
  tools?: string[];
  sessionId?: string;
  isResume?: boolean;
  options?: CliTransportOptions;
}): { process: ChildProcess; env: NodeJS.ProcessEnv } {
  const binary = findClaudeBinary(params.options?.binaryPath);
  const env = buildCliEnv(binary, params.options?.env);

  const args: string[] = [];

  // 세션 재개 vs 새 실행
  if (params.isResume && params.sessionId) {
    args.push("-p", params.prompt, "--resume", params.sessionId);
  } else {
    args.push("-p", params.prompt);
  }

  // 출력 형식
  args.push("--output-format", "stream-json", "--include-partial-messages", "--verbose");

  // 모델
  if (params.modelId) {
    args.push("--model", params.modelId);
  }

  // 시스템 프롬프트
  if (params.systemPrompt) {
    args.push("--append-system-prompt", params.systemPrompt);
  }

  // 도구
  if (params.tools && params.tools.length > 0) {
    args.push("--allowedTools", params.tools.join(","));
  }

  // 세션 ID (신규)
  if (params.sessionId && !params.isResume) {
    args.push("--session-id", params.sessionId);
  }

  // 권한 우회
  args.push("--permission-mode", "bypassPermissions");

  const proc = spawn(binary, args, {
    cwd: params.options?.cwd || process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return { process: proc, env };
}
```

### 4.2 `claude-cli-stream-adapter.ts` — JSONL → Transport 이벤트 변환 (신규)

```typescript
// packages/openclaw/src/agents/claude-cli-stream-adapter.ts

import type { ChildProcess } from "child_process";

/**
 * CLI의 stream-json 출력(JSONL)을 OpenClaw 내부 transport 이벤트로 변환한다.
 *
 * CLI 출력 형식 (--output-format stream-json):
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}],...},"is_partial":true}
 *   {"type":"result","message":{"content":[...],"stop_reason":"end_turn","usage":{...}}}
 *
 * 변환 대상 (transport-stream-shared.ts의 이벤트):
 *   { type: "start", partial }
 *   { type: "text_start", contentIndex, partial }
 *   { type: "text_delta", contentIndex, delta, partial }
 *   { type: "thinking_start", contentIndex, partial }
 *   { type: "thinking_delta", contentIndex, delta, partial }
 *   { type: "tool_start", contentIndex, partial }
 *   { type: "tool_delta", contentIndex, delta, partial }
 *   { type: "done", output }
 */

export interface CliStreamEvent {
  type: "assistant" | "result" | "error" | "tool_use" | "tool_result";
  message?: {
    content: Array<{
      type: "text" | "tool_use" | "tool_result" | "thinking";
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
    model?: string;
    stop_reason?: string;
    usage?: { input_tokens: number; output_tokens: number };
  };
  error?: string;
  is_partial?: boolean;
}

export interface TransportEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
  partial?: unknown;
  output?: unknown;
}

/**
 * ChildProcess의 stdout을 파싱하여 TransportEvent 제너레이터를 반환한다.
 */
export async function* parseCliStream(proc: ChildProcess): AsyncGenerator<TransportEvent> {
  if (!proc.stdout) throw new Error("CLI 프로세스에 stdout이 없습니다");

  proc.stdout.setEncoding("utf8");
  let buffer = "";
  let lastTextLen = 0;
  let lastThinkingLen = 0;
  let startEmitted = false;

  const lineQueue: string[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  proc.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) lineQueue.push(line.trim());
    }
    resolve?.();
  });

  proc.stdout.on("end", () => {
    if (buffer.trim()) lineQueue.push(buffer.trim());
    done = true;
    resolve?.();
  });

  proc.on("error", () => { done = true; resolve?.(); });
  proc.on("close", () => { done = true; resolve?.(); });

  while (true) {
    if (lineQueue.length === 0 && !done) {
      await new Promise<void>((r) => { resolve = r; });
      resolve = null;
    }

    while (lineQueue.length > 0) {
      const line = lineQueue.shift()!;
      let event: CliStreamEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // JSONL이 아닌 줄 무시
      }

      if (!startEmitted) {
        startEmitted = true;
        yield { type: "start", partial: { role: "assistant", content: [], model: event.message?.model } };
      }

      if (event.type === "assistant" && event.message?.content) {
        for (let i = 0; i < event.message.content.length; i++) {
          const block = event.message.content[i];

          if (block.type === "text" && block.text) {
            const newText = block.text.slice(lastTextLen);
            if (newText) {
              if (lastTextLen === 0) {
                yield { type: "text_start", contentIndex: i };
              }
              yield { type: "text_delta", contentIndex: i, delta: newText };
              lastTextLen = block.text.length;
            }
          }

          if (block.type === "thinking" && block.thinking) {
            const newThinking = block.thinking.slice(lastThinkingLen);
            if (newThinking) {
              if (lastThinkingLen === 0) {
                yield { type: "thinking_start", contentIndex: i };
              }
              yield { type: "thinking_delta", contentIndex: i, delta: newThinking };
              lastThinkingLen = block.thinking.length;
            }
          }

          if (block.type === "tool_use" && block.name) {
            yield { type: "tool_start", contentIndex: i, delta: JSON.stringify({ id: block.id, name: block.name, input: block.input }) };
          }
        }
      }

      if (event.type === "result") {
        yield {
          type: "done",
          output: {
            content: event.message?.content,
            stopReason: event.message?.stop_reason || "end_turn",
            usage: event.message?.usage ? {
              input: event.message.usage.input_tokens,
              output: event.message.usage.output_tokens,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: event.message.usage.input_tokens + event.message.usage.output_tokens,
            } : undefined,
          },
        };
      }

      if (event.type === "error") {
        yield { type: "error", delta: event.error || "CLI 실행 오류" };
      }
    }

    if (done && lineQueue.length === 0) break;
  }
}
```

### 4.3 `anthropic-transport-stream.ts` — CLI 모드 분기 추가 (수정)

현재 `createAnthropicMessagesTransportStreamFn()` (line 595) 함수의 시작 부분에 CLI 모드 분기를 추가한다.

**변경 전** (line 595-600):

```typescript
export function createAnthropicMessagesTransportStreamFn(): StreamFn {
  return (rawModel, context, rawOptions) => {
    const model = rawModel as AnthropicTransportModel;
    const options = rawOptions as AnthropicTransportOptions | undefined;
    const { eventStream, stream } = createWritableTransportEventStream();
    void (async () => {
```

**변경 후**:

```typescript
import { findClaudeBinary, isCliBinaryAvailable, spawnClaudeProcess } from "./claude-cli-transport.js";
import { parseCliStream } from "./claude-cli-stream-adapter.js";

/** CLI 백엔드 모드인지 확인. provider가 claude-cli이거나 환경변수로 지정 */
function isCliBackendMode(model: AnthropicTransportModel): boolean {
  if (process.env.OPENCLAW_ANTHROPIC_BACKEND === "cli") return true;
  if (model.provider === "claude-cli") return true;
  return false;
}

export function createAnthropicMessagesTransportStreamFn(): StreamFn {
  return (rawModel, context, rawOptions) => {
    const model = rawModel as AnthropicTransportModel;
    const options = rawOptions as AnthropicTransportOptions | undefined;
    const { eventStream, stream } = createWritableTransportEventStream();

    // CLI 백엔드 모드 분기
    if (isCliBackendMode(model) && isCliBinaryAvailable()) {
      void (async () => {
        try {
          // 시스템 프롬프트 조립
          const systemPrompt = context.systemPrompt || undefined;

          // 도구 목록 추출
          const tools = context.tools?.map((t) => {
            const name = typeof t === "object" && "name" in t ? (t as { name: string }).name : "";
            return CLAUDE_CODE_TOOL_LOOKUP.get(normalizeLowercaseStringOrEmpty(name)) || name;
          }).filter(Boolean);

          // 메시지에서 마지막 사용자 프롬프트 추출
          const lastUserMsg = [...context.messages].reverse().find((m) => m.role === "user");
          const prompt = typeof lastUserMsg?.content === "string"
            ? lastUserMsg.content
            : JSON.stringify(lastUserMsg?.content || "");

          const { process: proc } = spawnClaudeProcess({
            prompt,
            modelId: model.id,
            systemPrompt,
            tools,
            options: { timeoutMs: 300_000 },
          });

          for await (const event of parseCliStream(proc)) {
            stream.push(event as never);
          }

          finalizeTransportStream(stream, eventStream);
        } catch (err) {
          failTransportStream(stream, eventStream, err instanceof Error ? err : new Error(String(err)));
        }
      })();
      return eventStream;
    }

    // 기존 SDK 경로 (폴백)
    void (async () => {
      // ... 기존 코드 그대로 유지 ...
```

### 4.4 `gateway-manager.ts` — CLI 모드 환경변수 전달 (수정)

**변경 위치**: `startGateway()` 함수의 spawn env (line 185-194)

**변경 전**:

```typescript
env: {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  // ANTHROPIC_API_KEY: 제거 — claude-cli 백엔드는 자체 인증 사용
  OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT,
  OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
  OPENCLAW_CONFIG_DIR: process.env.OPENCLAW_CONFIG_DIR,
  DATA_DIR: process.env.DATA_DIR,
  NODE_ENV: process.env.NODE_ENV,
},
```

**변경 후**:

```typescript
env: {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  OPENCLAW_ANTHROPIC_BACKEND: 'cli',          // CLI 모드 활성화
  CLAUDE_CLI_PATH: CLAUDE_CLI,                 // claude 바이너리 경로 전달
  OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT,
  OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
  OPENCLAW_CONFIG_DIR: process.env.OPENCLAW_CONFIG_DIR,
  DATA_DIR: process.env.DATA_DIR,
  NODE_ENV: process.env.NODE_ENV,
},
```

`CLAUDE_CLI` import 추가 필요 (파일 상단):

```typescript
import { CLAUDE_CLI } from './claude-cli';
```

### 4.5 `openclaw-executor.ts` — CLI 폴백 시 claude 바이너리 사용 (수정)

Gateway 미가용 시 `openclaw agent` 대신 `claude` 바이너리를 직접 사용하도록 변경.

**변경 위치**: `agentRunViaCli()` 함수 (line 190-211)

**변경 전**:

```typescript
async function agentRunViaCli(params: AgentRunParams): Promise<AgentResult> {
  const binary = findOpenClawBinary();
  if (!binary) return { ok: false, error: 'openclaw_not_found' };

  const args = ['agent', '-m', params.message, '--json'];
  // ...
}
```

**변경 후**:

```typescript
import { CLAUDE_CLI, CLAUDE_ENV } from './claude-cli';

async function agentRunViaCli(params: AgentRunParams): Promise<AgentResult> {
  // claude CLI 직접 실행 (구독 인증 사용)
  const args = ['-p', params.message];
  if (params.model) args.push('--model', params.model);
  if (params.timeout) args.push('--max-turns', '1'); // 단일 턴

  try {
    const { stdout } = await execFileAsync(CLAUDE_CLI, args, {
      encoding: 'utf8',
      timeout: (params.timeout ?? 300) * 1000 + 10_000,
      env: CLAUDE_ENV,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

### 4.6 `register.runtime.ts` — CLI 인증 기본값 전환 (수정)

**변경 위치**: `registerAnthropicPlugin()` 함수 내 auth 배열 (line 403-467)

`cli` 인증 방법의 `assistantPriority`를 최우선으로 변경하고, `setup-token`에 deprecated 표시:

**변경 전**:

```typescript
auth: [
  {
    id: "cli",
    // ...
    wizard: {
      // ...
      assistantPriority: -20,  // 낮은 우선순위
```

**변경 후**:

```typescript
auth: [
  {
    id: "cli",
    // ...
    wizard: {
      // ...
      assistantPriority: 100,  // 최우선
```

`setup-token` 방법에 deprecated 라벨 추가:

```typescript
  {
    id: "setup-token",
    label: "Anthropic setup-token (deprecated)",
    hint: "⚠️ 폐기됨 — CLI 인증으로 전환하세요",
```

---

## 5. 테스트

### 테스트 파일 목록

| 테스트 파일 | 대상 모듈 | 설명 |
|------------|----------|------|
| `packages/openclaw/src/agents/__tests__/claude-cli-transport.test.ts` | `claude-cli-transport.ts` | 바이너리 탐색, spawn 인자, CLI 가용성 |
| `packages/openclaw/src/agents/__tests__/claude-cli-stream-adapter.test.ts` | `claude-cli-stream-adapter.ts` | JSONL 파싱, transport 이벤트 변환 |
| `packages/electron-app/src/__tests__/openclaw-executor-cli.test.ts` | `openclaw-executor.ts` | claude CLI 폴백 실행 |

### 테스트 케이스 명세

```typescript
// packages/openclaw/src/agents/__tests__/claude-cli-transport.test.ts

describe('findClaudeBinary', () => {
  it('CLAUDE_CLI_PATH 환경변수가 있으면 해당 경로를 반환한다', () => { /* ... */ });
  it('which claude로 발견되면 해당 경로를 반환한다', () => { /* ... */ });
  it('글로벌 경로에서 발견되면 해당 경로를 반환한다', () => { /* ... */ });
  it('모두 실패하면 "claude" 문자열을 반환한다', () => { /* ... */ });
});

describe('buildCliEnv', () => {
  it('바이너리 디렉터리를 PATH 앞에 추가한다', () => { /* ... */ });
  it('이미 PATH에 포함되어 있으면 중복 추가하지 않는다', () => { /* ... */ });
  it('추가 환경변수를 병합한다', () => { /* ... */ });
});

describe('isCliBinaryAvailable', () => {
  it('claude --version이 성공하면 true를 반환한다', () => { /* ... */ });
  it('실행 실패하면 false를 반환한다', () => { /* ... */ });
});

describe('spawnClaudeProcess', () => {
  it('기본 인자로 spawn한다: -p, --output-format, --verbose', () => { /* ... */ });
  it('modelId가 있으면 --model 인자를 추가한다', () => { /* ... */ });
  it('tools가 있으면 --allowedTools 인자를 추가한다', () => { /* ... */ });
  it('sessionId가 있으면 --session-id 인자를 추가한다', () => { /* ... */ });
  it('isResume이면 --resume 인자를 사용한다', () => { /* ... */ });
});
```

```typescript
// packages/openclaw/src/agents/__tests__/claude-cli-stream-adapter.test.ts

describe('parseCliStream', () => {
  it('텍스트 JSONL을 text_start + text_delta로 변환한다', () => {
    // 입력: {"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]},"is_partial":true}
    // 기대: [{ type: "start" }, { type: "text_start" }, { type: "text_delta", delta: "Hello" }]
  });
  it('점진적 텍스트에서 델타만 추출한다', () => {
    // 입력1: text:"He"  → delta:"He"
    // 입력2: text:"Hello" → delta:"llo"
  });
  it('thinking 블록을 thinking_start + thinking_delta로 변환한다', () => { /* ... */ });
  it('tool_use 블록을 tool_start로 변환한다', () => { /* ... */ });
  it('result 이벤트를 done으로 변환하고 usage를 포함한다', () => { /* ... */ });
  it('error 이벤트를 error로 변환한다', () => { /* ... */ });
  it('잘못된 JSON 줄은 무시한다', () => { /* ... */ });
  it('빈 stdout에서 프로세스 종료 시 빈 제너레이터를 반환한다', () => { /* ... */ });
});
```

```typescript
// packages/electron-app/src/__tests__/openclaw-executor-cli.test.ts

const { execFileAsync: mockExecFile } = vi.hoisted(() => ({
  execFileAsync: vi.fn(),
}));

vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('util', () => ({ promisify: () => mockExecFile }));

describe('agentRunViaCli (claude CLI 폴백)', () => {
  it('claude CLI로 프롬프트를 실행하고 stdout을 반환한다', async () => {
    mockExecFile.mockResolvedValue({ stdout: 'CLI 응답 결과' });
    const result = await agentRun({ message: '테스트' });
    expect(result).toEqual({ ok: true, output: 'CLI 응답 결과' });
    expect(mockExecFile).toHaveBeenCalledWith(
      expect.any(String),
      ['-p', '테스트'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });
  it('타임아웃 시 에러를 반환한다', async () => {
    mockExecFile.mockRejectedValue(new Error('ETIMEDOUT'));
    const result = await agentRun({ message: '테스트', timeout: 5 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ETIMEDOUT');
  });
  it('model 인자가 있으면 --model 플래그를 전달한다', async () => {
    mockExecFile.mockResolvedValue({ stdout: 'ok' });
    await agentRun({ message: '테스트', model: 'claude-sonnet-4-6' });
    expect(mockExecFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['--model', 'claude-sonnet-4-6']),
      expect.anything(),
    );
  });
});
```

### Mock 대상

| 대상 | Mock 방법 | 이유 |
|------|-----------|------|
| `child_process.spawn` | `vi.mock('child_process')` | 실제 프로세스 실행 방지 |
| `child_process.execFile` | `vi.hoisted()` + `promisify` mock | 비동기 실행 제어 |
| `child_process.execSync` | `vi.mock` | `which claude`, `claude --version` 제어 |
| `fs.existsSync` | `vi.mock('fs')` | 바이너리 경로 존재 여부 제어 |

---

## 6. 구현 단계

### Phase 1: CLI Transport 모듈 (신규 파일 2개)

| 순서 | 작업 | 파일 |
|------|------|------|
| 1-1 | CLI spawn + 바이너리 탐색 모듈 생성 | `packages/openclaw/src/agents/claude-cli-transport.ts` |
| 1-2 | JSONL → TransportEvent 변환기 생성 | `packages/openclaw/src/agents/claude-cli-stream-adapter.ts` |

### Phase 2: 추론 경로 분기 (수정 1개)

| 순서 | 작업 | 파일 |
|------|------|------|
| 2-1 | `createAnthropicMessagesTransportStreamFn()`에 CLI 모드 분기 추가 | `packages/openclaw/src/agents/anthropic-transport-stream.ts` |

### Phase 3: AI Hub 연동 (수정 2개)

| 순서 | 작업 | 파일 |
|------|------|------|
| 3-1 | Gateway spawn 시 `OPENCLAW_ANTHROPIC_BACKEND=cli` + `CLAUDE_CLI_PATH` 환경변수 전달 | `packages/electron-app/src/lib/gateway-manager.ts` |
| 3-2 | `agentRunViaCli()`가 `claude` 바이너리를 직접 사용하도록 변경 | `packages/electron-app/src/lib/openclaw-executor.ts` |

### Phase 4: 인증 기본값 전환 (수정 2개)

| 순서 | 작업 | 파일 |
|------|------|------|
| 4-1 | CLI 인증 우선순위 최상위로 변경, setup-token deprecated 표시 | `packages/openclaw/extensions/anthropic/register.runtime.ts` |
| 4-2 | `CLAUDE_CLI_PATH` 환경변수 문서화 | `packages/openclaw/.env.example` |

### Phase 5: 테스트 (신규 3개)

| 순서 | 작업 | 파일 |
|------|------|------|
| 5-1 | CLI transport 테스트 | `packages/openclaw/src/agents/__tests__/claude-cli-transport.test.ts` |
| 5-2 | JSONL 변환기 테스트 | `packages/openclaw/src/agents/__tests__/claude-cli-stream-adapter.test.ts` |
| 5-3 | executor CLI 폴백 테스트 | `packages/electron-app/src/__tests__/openclaw-executor-cli.test.ts` |

### Phase 6: 문서화

| 순서 | 작업 | 파일 |
|------|------|------|
| 6-1 | README에 OpenClaw CLI 백엔드 설정 섹션 추가 | `README.md` |

---

## 7. 주의사항

### 7.1 보안

- `claude` CLI의 인증 상태는 `~/.claude/` 디렉터리에 저장됨. Gateway 프로세스가 이 디렉터리에 접근 가능해야 함
- `--permission-mode bypassPermissions` 플래그 사용 시 파일 시스템 접근이 무제한. 워크스페이스 디렉터리를 `cwd`로 제한
- 환경변수에 API 키를 전달하지 않음. `CLAUDE_CLI_PATH`만 전달

### 7.2 호환성

- **기존 API 키 사용자**: `OPENCLAW_ANTHROPIC_BACKEND` 환경변수가 없으면 기존 SDK 경로 유지 (폴백)
- **Vertex AI 경로**: `anthropic-vertex-stream.ts`는 변경하지 않음. GCP 환경은 API 키 방식 유지
- **OpenClaw 버전**: `claude-cli-transport.ts`는 OpenClaw 내부 모듈이므로 버전 호환성 관리 필요

### 7.3 경로/환경

- macOS: `claude` 바이너리는 보통 `~/.npm-global/bin/claude` 또는 Homebrew 경로
- Linux: `/usr/local/bin/claude` 또는 nvm/fnm 경로
- Windows: PowerShell 래핑 필요 (c3의 `route.ts:97-99` 패턴 참고)
- `PATH`에 node가 포함되어야 shebang이 동작함 → `buildCliEnv()`에서 처리

### 7.4 타이밍/동시성

- 각 요청마다 새 `claude` 프로세스를 spawn → 프로세스 시작 오버헤드 1-2초
- 구독 플랜별 동시 실행 제한:
  - Pro: 동시 세션 제한 있음 → 큐잉 필요할 수 있음
  - Max: 상대적으로 여유 → 큐잉 불필요
- Gateway가 여러 요청을 동시에 받으면 `claude` 프로세스가 여러 개 spawn됨 → 메모리 주의

### 7.5 엣지 케이스

- `claude` 바이너리 미설치: `isCliBinaryAvailable()` → false → SDK 폴백
- `claude auth login` 미실행: CLI가 인증 에러 반환 → `error` 이벤트로 전파
- CLI 프로세스 비정상 종료: stderr 캡처 → 에러 메시지 추출
- JSONL 파싱 실패: 비JSON 줄(진행률 표시 등) 무시
- 타임아웃: `proc.kill()` 호출 → 프로세스 강제 종료

### 7.6 한계/향후 과제

- **프롬프트 캐시**: SDK는 `cache_control` 헤더로 세밀한 캐시 제어 가능. CLI는 내부적으로 관리하므로 직접 제어 불가
- **세밀한 토큰 사용량 추적**: CLI의 usage 정보가 SDK보다 제한적일 수 있음
- **도구 라운드트립**: 멀티턴 도구 사용 시 CLI의 대화 모드가 stdin을 요구할 수 있음 → Phase 1에서는 단일 턴만 지원, 이후 확장

---

## 8. 기대 효과

### 전환 전 (현재)

```
사용자: "내일 아침 10시에 뉴스 분석해줘"
시스템: ❌ Gateway 500 에러 (setup-token 폐기)
비용:   토큰당 과금 (setup-token 유효했을 때)
인증:   ANTHROPIC_API_KEY 별도 관리 필요
```

### 전환 후

```
사용자: "내일 아침 10시에 뉴스 분석해줘"
시스템: ✅ claude CLI spawn → 구독 인증으로 실행 → 크론 등록 → 완료 보고
비용:   구독제 (Pro/Max 정액, 추가 비용 없음)
인증:   claude auth login 한 번만 실행하면 영구 유효
```

### 후속 기능

- 이 전환이 완료되면 OpenClaw의 모든 Anthropic 추론이 구독제로 전환됨
- 미션 오케스트레이터의 `executor: 'openclaw'` 경로도 자동으로 CLI 모드 사용
- 향후 다른 프로바이더(OpenAI 등)도 동일 패턴으로 로컬 CLI 전환 가능

---

## 9. 파일 변경 요약

| 파일 | 작업 | 설명 |
|------|------|------|
| `packages/openclaw/src/agents/claude-cli-transport.ts` | **신규** | 바이너리 탐색 + spawn 실행 모듈 |
| `packages/openclaw/src/agents/claude-cli-stream-adapter.ts` | **신규** | JSONL → TransportEvent 변환기 |
| `packages/openclaw/src/agents/anthropic-transport-stream.ts` | **수정** | CLI 모드 분기 추가 (상단에 `isCliBackendMode` 체크) |
| `packages/electron-app/src/lib/gateway-manager.ts` | **수정** | `OPENCLAW_ANTHROPIC_BACKEND=cli` + `CLAUDE_CLI_PATH` env 전달 |
| `packages/electron-app/src/lib/openclaw-executor.ts` | **수정** | `agentRunViaCli()`가 `claude` 바이너리 직접 사용 |
| `packages/openclaw/extensions/anthropic/register.runtime.ts` | **수정** | CLI 인증 우선순위 상향, setup-token deprecated |
| `packages/openclaw/.env.example` | **수정** | `CLAUDE_CLI_PATH` 환경변수 추가 |
| `packages/openclaw/src/agents/__tests__/claude-cli-transport.test.ts` | **신규** | CLI transport 단위 테스트 |
| `packages/openclaw/src/agents/__tests__/claude-cli-stream-adapter.test.ts` | **신규** | JSONL 변환기 테스트 |
| `packages/electron-app/src/__tests__/openclaw-executor-cli.test.ts` | **신규** | executor CLI 폴백 테스트 |
| `README.md` | **수정** | OpenClaw CLI 백엔드 설정 섹션 추가 |

총 **5개 신규**, **6개 수정**
