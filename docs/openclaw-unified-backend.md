# OpenClaw 단일 백엔드 전환 명세서

> **목적**: 미션 시스템에서 최상위 오케스트레이터(라우팅 분석)를 제외한 모든 실행을 OpenClaw Gateway로 통합하고, 이중 executor 분기(`c3`/`openclaw`)를 제거하여 에이전트 작업과 최종 보고서 생성을 전부 OpenClaw -> Claude CLI 바이너리 경로로 실행한다.
>
> **작성일**: 2026-04-12

---

## 1. 배경과 동기

### 1.1 현재 문제

현재 미션 시스템은 **두 계층에 걸친 이중 실행 경로**를 유지하고 있다.

```
사용자 -> "코드 리뷰 + 슬랙으로 결과 보내줘"
       -> Claude CLI가 라우팅 분석 (executor 결정)        <- 오케스트레이터
       -> executor === 'c3'     -> electron-app이 직접 Claude CLI spawn   <- 문제 1
       -> executor === 'openclaw' -> OpenClaw Gateway -> SDK -> API 과금/폐기  <- 문제 2
```

**구체적 문제점:**

1. **이중 실행 경로 복잡성**: `executor: 'c3' | 'openclaw'` 분기가 `mission-runner.ts`, `run/route.ts`, 라우팅 프롬프트에 걸쳐 존재. 유지보수 비용 증가
2. **c3 경로의 한계**: `callClaude()` 함수가 단일 턴 `execFile`로 동작. 세션 지속, 멀티턴 대화, 스트리밍 중간 결과 보고 등 OpenClaw Gateway의 고급 기능 사용 불가
3. **최종 보고서도 직접 호출**: `consolidateResults()`가 `callClaude()`로 최종 문서를 생성. Gateway를 우회
4. **OpenClaw SDK 경로 단절**: `executor === 'openclaw'` 경로에서 Gateway가 여전히 Anthropic SDK -> API를 직접 호출 (setup-token 폐기로 500 에러)

| 경로 | 현재 동작 | 문제 |
|------|-----------|------|
| 라우팅 분석 (오케스트레이터) | `execFile(CLAUDE_CLI)` 직접 | **유지** - 조직도/리소스 판단은 로컬에서 빠르게 |
| `executor='c3'` 실행 | `callClaude()` -> `execFile(CLAUDE_CLI)` | 단일 턴, 세션 없음, Gateway 기능 미활용 |
| `executor='openclaw'` 실행 | `agentRun()` -> Gateway -> SDK | API 과금/폐기 |
| 최종 보고서 | `callClaude()` 직접 | Gateway 우회 |

> **참고**: 라우팅 분석(최상위 오케스트레이터)은 조직도 기반 리소스 판단, DB 저장 위치 결정 등 로컬에서 빠르게 수행해야 하는 단발성 작업이므로 Claude CLI 직접 호출을 **의도적으로 유지**한다. 문제는 그 이후 실행 단계의 이중 경로이다.

### 1.2 목표 상태

**최상위 오케스트레이터**(라우팅 분석)는 Claude CLI 직접 호출을 유지하고, **그 이후 모든 실행**은 OpenClaw Gateway -> Claude CLI 바이너리 경로로 통합된다.

```
사용자 -> "코드 리뷰 + 슬랙으로 결과 보내줘"
       -> Claude CLI 직접 호출로 라우팅 분석 (오케스트레이터, 유지)
       -> routing[] 결정 (executor 분기 없음 - 전부 OpenClaw)
       -> OpenClaw Gateway가 에이전트 작업 실행
       -> OpenClaw Gateway -> claude CLI spawn -> 구독 인증
       -> OpenClaw Gateway가 최종 보고서 생성
       -> 응답 수신 -> 결과 저장
```

### 1.3 선택의 이유

| 방안 | 장점 | 단점 |
|------|------|------|
| **A. 오케스트레이터 유지 + 실행 OpenClaw 통합 (채택)** | 라우팅은 빠르게, 실행은 Gateway 기능 전면 활용 | Gateway 의존성 증가 |
| B. 전부 OpenClaw (라우팅 분석 포함) | 완전 단일 경로 | 라우팅 분석에 Gateway 오버헤드, 로컬 판단 지연 |
| C. 전부 c3 (OpenClaw 제거) | 의존성 최소 | 스케줄링/채널 전송/세션 관리 불가 |
| D. 현행 유지 (이중 경로) | 변경 없음 | 복잡성 지속, SDK 경로 단절 |

**A를 채택하는 이유**: 오케스트레이터는 조직도/리소스 판단이라는 단발성 작업으로 직접 호출이 적합. 이후 실행은 세션 관리, 채널 전송, 스케줄링 등 OpenClaw Gateway의 고급 기능이 필요. 두 계층을 명확히 분리하면 유지보수성과 기능성을 동시에 확보할 수 있다.

### 1.4 선행 조건

이 명세서는 **`docs/openclaw-cli-backend-plan.md` (Phase 1)이 완료된 상태**를 전제한다.

Phase 1 완료 상태:
- OpenClaw Gateway가 `claude-cli/` 프로바이더 접두사로 Claude CLI 바이너리를 spawn할 수 있음
- `CliBackendPlugin`(`extensions/anthropic/cli-backend.ts`)이 정상 동작
- Gateway에 `OPENCLAW_ANTHROPIC_BACKEND=cli` 환경변수가 전달됨
- `claude` 바이너리 경로가 Gateway 프로세스에서 접근 가능

Phase 1이 미완료 시: 해당 명세서를 먼저 구현한 후 이 명세서를 진행한다.

---

## 2. 현재 상태 분석

### 2.1 관련 파일 맵

#### 최상위 오케스트레이터 (유지 - 프롬프트만 수정)

| 파일 | 역할 | 변경 범위 |
|------|------|-----------|
| `packages/electron-app/src/app/api/missions/route.ts` | 미션 생성 + 라우팅 분석 (`execFile(CLAUDE_CLI)` 직접 호출) | 프롬프트에서 `executor` 판단 로직만 제거 |
| `packages/electron-app/src/lib/claude-cli.ts` | Claude 바이너리 경로 탐색 + 환경변수 | **변경 없음** |

#### 미션 실행 (변경 대상 - 전부 OpenClaw으로 전환)

| 파일 | 역할 |
|------|------|
| `packages/electron-app/src/app/api/missions/[id]/run/route.ts` | 미션 SSE 실행 - `executor` 분기 포함 |
| `packages/electron-app/src/lib/openclaw-executor.ts` | OpenClaw CLI/Gateway 통합 인터페이스 |
| `packages/electron-app/src/lib/openclaw-client.ts` | Gateway HTTP 클라이언트 |
| `packages/electron-app/src/lib/gateway-manager.ts` | Gateway 프로세스 관리 |

#### 참고 (변경 불필요)

| 파일 | 역할 |
|------|------|
| `packages/openclaw/extensions/anthropic/cli-backend.ts` | CLI 백엔드 플러그인 정의 (Phase 1에서 활성화) |
| `packages/electron-app/src/lib/db.ts` | 미션/잡 DB 스키마 |

### 2.2 현재 흐름

#### 미션 생성 시 라우팅 분석 (오케스트레이터 - 유지)

```
POST /api/missions { task }
  |- route.ts:204  setImmediate -> execFile(CLAUDE_CLI, ['-p', routingPrompt])
  |    |- Claude CLI가 조직도 기반 라우팅 JSON 생성
  |    |- executor: 'c3' | 'openclaw' 결정 (프롬프트에 의해)  <- 이 부분만 제거
  |    '- routing[], execution_plan, is_recurring 등 파싱
  '- 미션 상태: analyzing -> routed (또는 routing_failed)
```

#### 미션 실행 시 이중 분기 (변경 대상)

```
POST /api/missions/{id}/run
  |- routing.map(async (r, idx) => {
  |    if (r.executor === 'openclaw')            <- 제거
  |       -> agentRun() -> Gateway HTTP
  |    else (기본값 'c3')                         <- 제거
  |       -> runAgentTask() -> callClaude() -> execFile(CLAUDE_CLI)
  |  })
  '- consolidateResults() -> callClaude() -> execFile(CLAUDE_CLI)  <- 제거
```

### 2.3 현재 타입/인터페이스

#### RoutingEntry (executor 필드 포함)

```typescript
// packages/electron-app/src/app/api/missions/[id]/run/route.ts:18-31

interface RoutingEntry {
  org_id: string; org_type: string; org_name: string;
  agent_id: string; agent_name: string; subtask: string;
  gate_type?: 'auto' | 'human';
  executor?: 'c3' | 'openclaw';           // <- 제거 대상
  executor_reason?: string;                 // <- 제거 대상
  capability_tags?: string[];
  openclaw_params?: {                       // <- 통합 후 기본 파라미터로 승격
    thinking?: string;
    model?: string;
    timeout_seconds?: number;
    session_key?: string;
  };
}
```

#### AgentRunParams (현재 제한적)

```typescript
// packages/electron-app/src/lib/openclaw-executor.ts:47-57

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
```

**부족한 점**: `cwd`(작업 디렉터리), `tools`(허용 도구), `imagePaths`(이미지), `mcpConfigPath`(MCP 설정), `systemPrompt`(시스템 프롬프트) 미지원

### 2.4 현재 API 엔드포인트

| 엔드포인트 | 메서드 | 역할 | 현재 실행 경로 | 변경 여부 |
|-----------|--------|------|---------------|-----------|
| `/api/missions` | POST | 미션 생성 + 라우팅 분석 | `execFile(CLAUDE_CLI)` 직접 | 프롬프트만 수정 |
| `/api/missions/{id}/run` | POST | 미션 SSE 실행 | `c3`: 직접 / `openclaw`: Gateway | **전부 OpenClaw** |
| `/api/openclaw/gateway` | GET | Gateway 상태 | HTTP 헬스체크 | 변경 없음 |
| Gateway `/v1/chat/completions` | POST | OpenClaw 추론 | CLI 백엔드 (Phase 1 후) | 변경 없음 |

### 2.5 callClaude() 사용처 분석

`callClaude()` 함수는 `run/route.ts`에서 두 곳에서 호출된다:

| 호출 위치 | 용도 | 변경 |
|-----------|------|------|
| `runAgentTask()` (line 433) | 에이전트 작업 실행 | **`agentRun()`으로 대체** |
| `consolidateResults()` (line 492) | 최종 보고서 생성 | **`agentRun()`으로 대체** |

`route.ts` (미션 생성)에서의 호출:

| 호출 위치 | 용도 | 변경 |
|-----------|------|------|
| `POST /api/missions` (line 205) | 라우팅 분석 (오케스트레이터) | **유지** |

---

## 3. 설계

### 3.1 전체 흐름

```
+=====================================================================+
| AI Hub electron-app                                                  |
|                                                                      |
|  [1단계: 오케스트레이터 - Claude CLI 직접 호출 유지]                     |
|                                                                      |
|  POST /api/missions { task }                                         |
|    |                                                                 |
|    v                                                                 |
|  execFile(CLAUDE_CLI, ['-p', routingPrompt])  <- 기존 방식 유지       |
|    |                                                                 |
|    v                                                                 |
|  routing[] 파싱 (executor 필드 없음) -> 미션 상태 'routed'             |
|                                                                      |
|  [2단계: 에이전트 실행 - 전부 OpenClaw Gateway 경유]                    |
|                                                                      |
|  POST /api/missions/{id}/run                                         |
|    |                                                                 |
|    v                                                                 |
|  routing.map(r => {                                                  |
|    agentRun({                                                        |
|      message: prompt,                                                |
|      cwd: workspacePath,        <- [신규] 작업 디렉터리                |
|      allowTools: true,          <- [신규] 도구 허용                    |
|      imagePaths: [...],         <- [신규] 이미지 경로                  |
|      systemPrompt: agent.soul,  <- [신규] 시스템 프롬프트              |
|    })                                                                |
|  })                                                                  |
|    |                                                                 |
|    v                                                                 |
|  +-------------------------------------------+                       |
|  | OpenClaw Gateway                          |                       |
|  |   -> CLI 백엔드 -> spawn('claude', [...]) |                       |
|  |   -> cwd: 워크스페이스, tools: 활성화      |                       |
|  |   -> 구독 인증 -> 작업 결과 반환           |                       |
|  +-------------------------------------------+                       |
|    |                                                                 |
|    v                                                                 |
|  [3단계: 최종 보고서 - OpenClaw Gateway 경유]                          |
|                                                                      |
|  agentRun({ message: consolidationPrompt })                          |
|    |                                                                 |
|    v                                                                 |
|  미션 상태 'done'                                                     |
+=====================================================================+
```

### 3.2 파일 변경 목록

```
packages/electron-app/
+-- src/
|   +-- app/api/missions/
|   |   +-- route.ts                         # [수정] 라우팅 프롬프트에서 executor 판단 로직 제거 (실행 방식은 유지)
|   |   '-- [id]/run/
|   |       '-- route.ts                     # [수정] executor 분기 제거, 전부 agentRun()
|   +-- lib/
|   |   +-- openclaw-executor.ts             # [수정] AgentRunParams 확장, agentRunViaGateway 고도화
|   |   +-- openclaw-client.ts               # [수정] sendToGateway에 확장 파라미터 지원
|   |   '-- gateway-manager.ts               # [수정] Gateway 필수 의존성 강화 (헬스체크)
|   '-- __tests__/
|       +-- openclaw-executor-unified.test.ts # [신규] 통합 실행 테스트
|       '-- missions-run-unified.test.ts      # [신규] 미션 실행 통합 테스트
```

### 3.3 타입 정의

#### AgentRunParams (확장)

```typescript
// packages/electron-app/src/lib/openclaw-executor.ts

export interface AgentRunParams {
  message: string;
  agent?: string;
  thinking?: string;
  model?: string;
  timeout?: number;           // seconds (default 300)
  sessionId?: string;

  // -- 기존 OpenClaw 전용 --
  deliver?: boolean;
  channel?: string;
  to?: string;

  // -- [신규] 통합 실행을 위한 확장 필드 --
  cwd?: string;               // 작업 디렉터리 (workspace path)
  allowTools?: boolean;        // Claude CLI에 도구 접근 허용 (Edit, Write, Read, Bash)
  imagePaths?: string[];       // 이미지 파일 경로 배열
  systemPrompt?: string;       // 시스템 프롬프트 (에이전트 soul 등)
  mcpConfigPath?: string;      // MCP 서버 설정 파일 경로
  extraEnv?: Record<string, string>; // 추가 환경변수 (vault 시크릿 등)
}
```

#### RoutingEntry (executor 제거)

```typescript
// packages/electron-app/src/app/api/missions/[id]/run/route.ts

interface RoutingEntry {
  org_id: string; org_type: string; org_name: string;
  agent_id: string; agent_name: string; subtask: string;
  gate_type?: 'auto' | 'human';
  // executor 필드 제거 - 전부 OpenClaw
  capability_tags?: string[];
  thinking?: string;            // <- openclaw_params에서 승격
  model?: string;               // <- openclaw_params에서 승격
  timeout_seconds?: number;     // <- openclaw_params에서 승격
  session_key?: string;         // <- openclaw_params에서 승격
}
```

---

## 4. 상세 구현

### 4.1 `openclaw-executor.ts` - 통합 실행 인터페이스 확장 (수정)

#### 4.1.1 AgentRunParams 확장

**변경 전** (line 47-57):

```typescript
export interface AgentRunParams {
  message: string;
  agent?: string;
  thinking?: string;
  model?: string;
  timeout?: number;
  sessionId?: string;
  deliver?: boolean;
  channel?: string;
  to?: string;
}
```

**변경 후**:

```typescript
export interface AgentRunParams {
  message: string;
  agent?: string;
  thinking?: string;
  model?: string;
  timeout?: number;           // seconds (default 300)
  sessionId?: string;
  deliver?: boolean;
  channel?: string;
  to?: string;

  // 통합 실행 확장 필드
  cwd?: string;
  allowTools?: boolean;
  imagePaths?: string[];
  systemPrompt?: string;
  mcpConfigPath?: string;
  extraEnv?: Record<string, string>;
}
```

#### 4.1.2 agentRunViaGateway() 확장

**변경 전** (line 166-188):

```typescript
async function agentRunViaGateway(params: AgentRunParams): Promise<AgentResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (GATEWAY_TOKEN) headers['Authorization'] = `Bearer ${GATEWAY_TOKEN}`;

  const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: params.agent ? `openclaw/${params.agent}` : 'openclaw',
      messages: [{ role: 'user', content: params.message }],
      stream: false,
    }),
    signal: AbortSignal.timeout((params.timeout ?? 300) * 1000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, error: `Gateway ${res.status}: ${body}` };
  }

  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  return { ok: true, output: data.choices?.[0]?.message?.content ?? '' };
}
```

**변경 후**:

```typescript
async function agentRunViaGateway(params: AgentRunParams): Promise<AgentResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (GATEWAY_TOKEN) headers['Authorization'] = `Bearer ${GATEWAY_TOKEN}`;

  // 시스템 프롬프트 + 이미지 경로를 메시지에 포함
  const messages: { role: string; content: string | object[] }[] = [];

  // 시스템 프롬프트가 있으면 system role로 추가
  if (params.systemPrompt) {
    messages.push({ role: 'system', content: params.systemPrompt });
  }

  // 이미지가 있으면 멀티모달 메시지 구성
  if (params.imagePaths?.length) {
    const content: object[] = [{ type: 'text', text: params.message }];
    for (const imgPath of params.imagePaths) {
      content.push({
        type: 'image_url',
        image_url: { url: `file://${imgPath}` },
      });
    }
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: params.message });
  }

  // cwd, 도구, MCP 등 확장 파라미터
  const body: Record<string, unknown> = {
    model: params.agent ? `openclaw/${params.agent}` : 'openclaw',
    messages,
    stream: false,
  };

  // Gateway 확장 필드 (OpenClaw이 CLI 백엔드에 전달)
  if (params.cwd || params.allowTools || params.mcpConfigPath || params.extraEnv) {
    body['openclaw'] = {
      cwd: params.cwd,
      allow_tools: params.allowTools,
      mcp_config_path: params.mcpConfigPath,
      extra_env: params.extraEnv,
    };
  }

  const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((params.timeout ?? 300) * 1000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return { ok: false, error: `Gateway ${res.status}: ${errBody}` };
  }

  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  return { ok: true, output: data.choices?.[0]?.message?.content ?? '' };
}
```

#### 4.1.3 agentRunViaCli() 폴백 - Claude CLI 직접 사용

Gateway 미가용 시 폴백도 Claude CLI를 직접 사용하도록 유지한다 (Phase 1에서 이미 변경됨).

**변경 후** (Phase 1 결과물에 확장 필드 추가):

```typescript
import { CLAUDE_CLI, CLAUDE_ENV } from './claude-cli';

async function agentRunViaCli(params: AgentRunParams): Promise<AgentResult> {
  // claude CLI 직접 실행 (구독 인증 사용)
  const args = ['-p', params.message];

  if (params.model) args.push('--model', params.model);
  if (params.allowTools) args.push('--allowedTools', 'Edit,Write,Read,Bash', '--dangerously-skip-permissions');
  if (params.systemPrompt) args.push('--append-system-prompt', params.systemPrompt);
  if (params.mcpConfigPath) args.push('--mcp-config', params.mcpConfigPath);

  // 이미지 경로 추가
  if (params.imagePaths?.length) {
    for (const imgPath of params.imagePaths) {
      args.push(imgPath);
    }
  }

  try {
    const { stdout } = await execFileAsync(CLAUDE_CLI, args, {
      encoding: 'utf8',
      timeout: (params.timeout ?? 300) * 1000 + 10_000,
      cwd: params.cwd || process.cwd(),
      env: { ...CLAUDE_ENV, ...params.extraEnv },
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    // 타임아웃 시 1회 재시도
    const e = err as NodeJS.ErrnoException & { killed?: boolean; stdout?: string };
    if (e.killed || e.code === 'ETIMEDOUT') {
      try {
        await new Promise(r => setTimeout(r, 3000));
        const { stdout } = await execFileAsync(CLAUDE_CLI, args, {
          encoding: 'utf8',
          timeout: (params.timeout ?? 300) * 1000 + 10_000,
          cwd: params.cwd || process.cwd(),
          env: { ...CLAUDE_ENV, ...params.extraEnv },
          maxBuffer: 10 * 1024 * 1024,
        });
        return { ok: true, output: stdout.trim() };
      } catch (retryErr) {
        return { ok: false, error: retryErr instanceof Error ? retryErr.message : String(retryErr) };
      }
    }
    // maxBuffer 초과 시 부분 출력 반환
    if (e.code === 'ERR_CHILD_PROCESS_STDOUT_MAX_BUFFER_SIZE' && e.stdout && e.stdout.trim().length > 50) {
      return { ok: true, output: e.stdout.trim() };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

### 4.2 `missions/route.ts` - 라우팅 프롬프트만 수정 (오케스트레이터 유지)

> **핵심**: `execFile(CLAUDE_CLI)` 실행 방식은 **그대로 유지**한다. 프롬프트에서 `executor` 판단 관련 내용만 제거한다.

#### 4.2.1 `buildRoutingPrompt()` 프롬프트 수정

**변경 위치**: `buildRoutingPrompt()` 함수 (line 314-386)

`executor` 결정 관련 프롬프트를 전부 제거하고, 모든 작업이 OpenClaw을 통해 실행된다는 내용으로 교체한다.

**변경 전** (핵심 부분):

```
## 실행 수단

이 시스템은 두 가지 실행 수단을 갖고 있습니다:

### c3 (Claude CLI) - 즉시 실행, 로컬 작업
...
### OpenClaw - 스케줄링, 외부 전송, 세션
...

executor 판단 기준:
- 기본값은 "c3" (로컬 Claude CLI 실행)
- 다음 경우 "openclaw" 사용:
  ...
```

**변경 후**:

```
## 실행 시스템

모든 작업은 OpenClaw을 통해 실행됩니다. OpenClaw은 다음 기능을 제공합니다:
- 로컬 파일 시스템 접근 (Read, Write, Edit, Bash 도구)
- 코드 수정, 빌드, 테스트 실행
- 크론 스케줄링: 1회 예약(at), 반복(cron/every)
- 채널 전송: Slack, Discord, Telegram 등
- 영속 세션: 이전 대화 컨텍스트 유지
```

#### 4.2.2 JSON 형식에서 `executor`, `executor_reason` 필드 제거

**변경 전**:

```json
{"routing": [{"org_id":"...","executor":"c3","executor_reason":"...","openclaw_params":{}}]}
```

**변경 후**:

```json
{"routing": [{"org_id":"...","org_type":"team","org_name":"...","agent_id":"...","agent_name":"...","subtask":"...","approach":"...","deliverables":[],"gate_type":"auto","capability_tags":[],"thinking":"low","model":null,"timeout_seconds":300}]}
```

`thinking`, `model`, `timeout_seconds` 필드를 routing 엔트리에 직접 포함 (기존 `openclaw_params` 중첩 제거).

#### 4.2.3 변경하지 않는 것

- `execFile(CLAUDE_CLI, promptArgs, ...)` 호출 방식 -> **유지**
- `setImmediate(() => { execFile(...) })` 패턴 -> **유지**
- `CLAUDE_CLI`, `CLAUDE_ENV`, `claudeSpawnError` import -> **유지**
- JSON 파싱 로직 -> **유지**
- 반복 미션 스케줄 생성 로직 -> **유지**

### 4.3 `missions/[id]/run/route.ts` - executor 분기 제거 (수정)

#### 4.3.1 RoutingEntry 타입 변경

**변경 전** (line 18-31):

```typescript
interface RoutingEntry {
  org_id: string; org_type: string; org_name: string;
  agent_id: string; agent_name: string; subtask: string;
  gate_type?: 'auto' | 'human';
  executor?: 'c3' | 'openclaw';
  executor_reason?: string;
  capability_tags?: string[];
  openclaw_params?: {
    thinking?: string;
    model?: string;
    timeout_seconds?: number;
    session_key?: string;
  };
}
```

**변경 후**:

```typescript
interface RoutingEntry {
  org_id: string; org_type: string; org_name: string;
  agent_id: string; agent_name: string; subtask: string;
  gate_type?: 'auto' | 'human';
  capability_tags?: string[];
  thinking?: string;
  model?: string;
  timeout_seconds?: number;
  session_key?: string;
}
```

#### 4.3.2 에이전트 실행 분기 통합

**변경 전** (line 195-214):

```typescript
try {
  const agent = await vmGet(`/api/agents/${r.agent_id}`, cookie);

  let output: string;
  if (r.executor === 'openclaw') {
    const result = await agentRun({
      message: buildOpenClawPrompt(r, mission.task, agent),
      agent: r.openclaw_params?.session_key || r.agent_id,
      thinking: r.openclaw_params?.thinking,
      model: r.openclaw_params?.model || agent?.model,
      timeout: r.openclaw_params?.timeout_seconds,
      sessionId: r.openclaw_params?.session_key,
    });
    if (!result.ok) throw new Error(result.error || 'OpenClaw 에이전트 실행 실패');
    output = result.output || '';
  } else {
    output = await runAgentTask(r, mission.task, agent, id, vaultEnv, cookie, mcpConfigPath, routing, boardPath);
  }
```

**변경 후**:

```typescript
try {
  const agent = await vmGet(`/api/agents/${r.agent_id}`, cookie);

  // 워크스페이스 경로 결정
  let wsPath = process.cwd();
  if (agent?.workspace_id) {
    try {
      const ws = await vmGet(`/api/workspaces/${agent.workspace_id}`, cookie);
      const realPath = ws?.path?.trim();
      if (realPath && fs.existsSync(realPath)) {
        wsPath = realPath;
      } else {
        const dataDir = process.env.DATA_DIR || path.join(process.cwd(), '.data');
        wsPath = path.join(dataDir, 'workspaces', agent.workspace_id);
        fs.mkdirSync(wsPath, { recursive: true });
      }
    } catch {
      const dataDir = process.env.DATA_DIR || path.join(process.cwd(), '.data');
      wsPath = path.join(dataDir, 'workspaces', agent.workspace_id);
      fs.mkdirSync(wsPath, { recursive: true });
    }
  }

  // 이미지 경로 수집
  const imagePaths: string[] = [];
  if (mission.images) {
    try { JSON.parse(mission.images).forEach((img: { path: string }) => { if (img.path) imagePaths.push(img.path); }); } catch {}
  }

  // 프롬프트 조립
  const routingCtx = routing.length > 1
    ? `\n## 전체 실행 계획\n이 미션은 다음 조직들이 동시에 진행합니다:\n${routing.map((re, i) => `  ${i + 1}. [${re.org_name}] ${re.agent_name}: ${re.subtask.split('\n')[0].slice(0, 100)}`).join('\n')}\n\n당신의 역할: **${r.org_name} (${r.agent_name})**\n`
    : '';
  const boardCtx = boardPath
    ? `\n## 협업 보드\n모든 에이전트가 공유하는 소통 공간: ${boardPath}\n\n1. 작업 시작 전 보드를 읽어 다른 에이전트의 진행 상황을 파악하세요\n2. 의존성, 이슈, 중요 발견 사항을 보드에 기록하세요\n3. 작업 완료 후 보드 하단에 결과를 추가하세요\n`
    : '';
  const prompt = `## 미션\n전체 미션: ${mission.task}${imagePaths.length ? `\n\n**참고: ${imagePaths.length}개 이미지 첨부됨**` : ''}\n${routingCtx}${boardCtx}\n## 배정된 업무\n${r.subtask}\n\n## 지시사항\nRead, Edit, Write, Bash 도구를 사용해 작업을 직접 완료하세요.\n완료 후 "## 완료된 작업" 섹션에 수행한 내용을 요약하세요.\n\n지금 바로 시작하세요:`;

  // 통합 실행 - 전부 agentRun()을 통해 OpenClaw Gateway 경유
  const result = await agentRun({
    message: prompt,
    agent: r.session_key || r.agent_id,
    thinking: r.thinking,
    model: r.model || agent?.model,
    timeout: r.timeout_seconds || 300,
    sessionId: r.session_key,
    cwd: wsPath,
    allowTools: true,
    imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
    systemPrompt: agent?.soul || undefined,
    mcpConfigPath: mcpConfigPath || undefined,
    extraEnv: vaultEnv,
  });

  if (!result.ok) throw new Error(result.error || '에이전트 실행 실패');
  const output = result.output || '';
```

#### 4.3.3 `callClaude()` 함수 제거

`run/route.ts`에서 `callClaude()` 함수 (line 350-380)를 삭제한다. 더 이상 사용되지 않는다.

#### 4.3.4 `runAgentTask()` 함수 제거

`run/route.ts`에서 `runAgentTask()` 함수 (line 383-434)를 삭제한다. 로직이 4.3.2의 인라인 코드로 대체됨.

#### 4.3.5 `consolidateResults()` 변경

**변경 전** (line 470-493):

```typescript
async function consolidateResults(task: string, results: { ... }[], missionId: string): Promise<string> {
  // ...
  return callClaude(prompt, process.cwd(), [], false, imagePaths);
}
```

**변경 후**:

```typescript
async function consolidateResults(task: string, results: { org_name: string; agent_name: string; output: string }[], missionId: string): Promise<string> {
  const mission = Missions.get(missionId);
  const imagePaths: string[] = [];
  if (mission?.images) {
    try { JSON.parse(mission.images).forEach((img: { path: string }) => { if (img.path) imagePaths.push(img.path); }); } catch {}
  }

  const resultBlock = results.map((r, i) => `### ${i + 1}. ${r.org_name} (${r.agent_name})\n${r.output}`).join('\n\n---\n\n');
  const prompt = `당신은 AI 조직의 최종 보고서 작성자입니다.\n\n## 원래 미션\n${task}\n\n## 각 조직의 완료 작업\n${resultBlock}\n\n위 결과를 종합한 최종 완료 보고서를 작성하세요.\n"다음 단계", "향후 제언" 같은 미래 계획은 포함하지 마세요.\n\n# 미션 완료 보고서\n형식으로 작성하고, 결과물만 출력하세요:`;

  const result = await agentRun({
    message: prompt,
    imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
    timeout: 120,
  });

  if (!result.ok) throw new Error(result.error || '통합 문서 생성 실패');
  return result.output || '';
}
```

#### 4.3.6 import 정리

**변경 전** (line 1-15):

```typescript
import { CLAUDE_CLI, CLAUDE_ENV } from '@/lib/claude-cli';
import { cronAdd, agentRun } from '@/lib/openclaw-executor';
import type { CronAddParams, AgentRunParams } from '@/lib/openclaw-executor';
import { execFile } from 'child_process';
import { promisify } from 'util';
```

**변경 후**:

```typescript
import { cronAdd, agentRun } from '@/lib/openclaw-executor';
import type { CronAddParams, AgentRunParams } from '@/lib/openclaw-executor';
```

`CLAUDE_CLI`, `CLAUDE_ENV`, `execFile`, `promisify` import 제거.

#### 4.3.7 `buildOpenClawPrompt()` 함수 제거

`run/route.ts`에서 `buildOpenClawPrompt()` 함수 (line 496-508)를 삭제한다. 4.3.2의 인라인 프롬프트로 대체됨.

### 4.4 `openclaw-client.ts` - Gateway 확장 파라미터 지원 (수정)

Gateway로 보내는 요청에 OpenClaw 확장 필드를 포함할 수 있도록 `sendToGateway` 인터페이스를 수정한다.

**변경 위치**: `sendToGateway()` 함수의 요청 body 구성 부분

기존 `sendToGateway()`의 body에 `openclaw` 확장 필드를 추가할 수 있도록 파라미터를 확장한다:

```typescript
// packages/electron-app/src/lib/openclaw-client.ts

export interface GatewayRequestOptions {
  agentId?: string;
  message: string;
  sessionKey?: string;
  model?: string;
  history?: { role: string; content: string }[];
  stream?: boolean;
  timeoutMs?: number;
  // 확장 필드
  openclaw?: {
    cwd?: string;
    allow_tools?: boolean;
    mcp_config_path?: string;
    extra_env?: Record<string, string>;
  };
}
```

### 4.5 `gateway-manager.ts` - Gateway 필수 의존성 강화 (수정)

Gateway가 시작되지 않은 상태에서 미션이 실행되면 모든 추론이 실패한다. Gateway 상태 확인을 강화한다.

**추가 함수**:

```typescript
// packages/electron-app/src/lib/gateway-manager.ts

/**
 * Gateway가 준비될 때까지 대기한다.
 * 미가동 시 자동 시작을 시도하고, 최대 waitMs까지 대기.
 * @returns true면 Gateway 사용 가능, false면 CLI 폴백 필요
 */
export async function ensureGatewayReady(waitMs = 30_000): Promise<boolean> {
  // 이미 준비됐으면 바로 반환
  if (await isGatewayReady()) return true;

  // 미가동이면 시작 시도
  if (!isGatewayRunning()) {
    await startGateway();
  }

  // 준비될 때까지 대기
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    if (await isGatewayReady()) return true;
    await new Promise(r => setTimeout(r, 1000));
  }

  return false;
}
```

---

## 5. 테스트

### 테스트 파일 목록

| 테스트 파일 | 대상 모듈 | 설명 |
|------------|----------|------|
| `packages/electron-app/src/__tests__/openclaw-executor-unified.test.ts` | `openclaw-executor.ts` | 확장된 AgentRunParams, Gateway/CLI 폴백 통합 |
| `packages/electron-app/src/__tests__/missions-run-unified.test.ts` | `missions/[id]/run/route.ts` | executor 분기 제거 후 통합 실행 검증 |

### 테스트 케이스 명세

```typescript
// packages/electron-app/src/__tests__/openclaw-executor-unified.test.ts

const { mockFetch, mockExecFile } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockExecFile: vi.fn(),
}));

vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('util', () => ({ promisify: () => mockExecFile }));

describe('agentRun (통합 실행)', () => {
  describe('Gateway 경유 실행', () => {
    it('기본 메시지를 Gateway로 전달하고 응답을 반환한다', async () => {
      // Gateway ready mock -> fetch mock -> 응답 검증
    });

    it('cwd, allowTools를 openclaw 확장 필드로 전달한다', async () => {
      // body.openclaw.cwd, body.openclaw.allow_tools 검증
    });

    it('systemPrompt를 system role 메시지로 변환한다', async () => {
      // messages[0].role === 'system' 검증
    });

    it('imagePaths를 멀티모달 content로 변환한다', async () => {
      // messages[1].content[1].type === 'image_url' 검증
    });

    it('extraEnv를 openclaw.extra_env로 전달한다', async () => {
      // body.openclaw.extra_env 검증
    });

    it('Gateway 500 에러 시 CLI 폴백으로 전환한다', async () => {
      // fetch -> 500 응답 -> execFile 호출 검증
    });
  });

  describe('CLI 폴백 실행', () => {
    it('Gateway 미가용 시 claude CLI를 직접 실행한다', async () => {
      // isGatewayReady -> false -> execFile(CLAUDE_CLI) 호출
    });

    it('allowTools가 true면 --allowedTools 플래그를 추가한다', async () => {
      // args에 '--allowedTools', 'Edit,Write,Read,Bash' 포함 검증
    });

    it('cwd를 execFile 옵션으로 전달한다', async () => {
      // options.cwd === '/path/to/workspace' 검증
    });

    it('imagePaths를 인자 끝에 추가한다', async () => {
      // args 끝에 이미지 경로 포함 검증
    });

    it('타임아웃 시 1회 재시도한다', async () => {
      // 1차 ETIMEDOUT -> 2차 성공 -> output 반환 검증
    });

    it('maxBuffer 초과 시 부분 출력을 반환한다', async () => {
      // ERR_CHILD_PROCESS_STDOUT_MAX_BUFFER_SIZE -> stdout 반환 검증
    });
  });
});
```

```typescript
// packages/electron-app/src/__tests__/missions-run-unified.test.ts

describe('POST /api/missions/{id}/run (통합 실행)', () => {
  it('executor 필드 없이 모든 에이전트를 agentRun()으로 실행한다', async () => {
    // executor 분기 없이 agentRun() 단일 경로 검증
  });

  it('워크스페이스 경로를 cwd로 전달한다', async () => {
    // agentRun({ cwd: '/path/to/workspace' }) 검증
  });

  it('에이전트 soul을 systemPrompt로 전달한다', async () => {
    // agentRun({ systemPrompt: agent.soul }) 검증
  });

  it('기존 executor="c3" routing 데이터도 정상 실행한다', async () => {
    // executor 필드가 있어도 무시하고 agentRun() 사용 검증 (하위호환)
  });

  it('consolidateResults가 agentRun()을 사용한다', async () => {
    // callClaude() 대신 agentRun() 호출 검증
  });

  it('agentRun 실패 시 에러를 기록하고 계속 진행한다', async () => {
    // 일부 에이전트 실패 시 나머지 계속 실행 검증
  });
});
```

### Mock 대상

| 대상 | Mock 방법 | 이유 |
|------|-----------|------|
| `agentRun()` | `vi.mock('@/lib/openclaw-executor')` | Gateway/CLI 실제 호출 방지 |
| `isGatewayReady()` | `vi.mock('@/lib/openclaw-client')` | Gateway 상태 제어 |
| `child_process.execFile` | `vi.hoisted()` + `promisify` mock | CLI 폴백 제어 |
| `fetch` (global) | `vi.fn()` | Gateway HTTP 응답 제어 |
| `fs.existsSync` | `vi.mock('fs')` | 워크스페이스 경로 존재 여부 제어 |

---

## 6. 구현 단계

### Phase 1: OpenClaw CLI 백엔드 활성화 (선행 조건)

> `docs/openclaw-cli-backend-plan.md` 구현. 이 Phase가 완료되어야 Phase 2 이하 진행 가능.

| 순서 | 작업 | 파일 |
|------|------|------|
| 1-1 | CLI transport 모듈 생성 | `packages/openclaw/src/agents/claude-cli-transport.ts` |
| 1-2 | JSONL 변환기 생성 | `packages/openclaw/src/agents/claude-cli-stream-adapter.ts` |
| 1-3 | transport에 CLI 모드 분기 추가 | `packages/openclaw/src/agents/anthropic-transport-stream.ts` |
| 1-4 | Gateway spawn 시 CLI 환경변수 전달 | `packages/electron-app/src/lib/gateway-manager.ts` |
| 1-5 | CLI 인증 우선순위 변경 | `packages/openclaw/extensions/anthropic/register.runtime.ts` |

### Phase 2: 실행 인터페이스 확장 (파일 2개)

| 순서 | 작업 | 파일 |
|------|------|------|
| 2-1 | `AgentRunParams` 확장 (cwd, allowTools, imagePaths, systemPrompt, mcpConfigPath, extraEnv) | `packages/electron-app/src/lib/openclaw-executor.ts` |
| 2-2 | `agentRunViaGateway()` 확장 (멀티모달 메시지, openclaw 확장 필드) | `packages/electron-app/src/lib/openclaw-executor.ts` |
| 2-3 | `agentRunViaCli()` 확장 (폴백에 확장 파라미터 반영) | `packages/electron-app/src/lib/openclaw-executor.ts` |
| 2-4 | Gateway 요청 옵션 타입 확장 | `packages/electron-app/src/lib/openclaw-client.ts` |

### Phase 3: 오케스트레이터 프롬프트 수정 (파일 1개)

| 순서 | 작업 | 파일 |
|------|------|------|
| 3-1 | `buildRoutingPrompt()`에서 executor 판단 프롬프트 제거 (실행 방식은 유지) | `packages/electron-app/src/app/api/missions/route.ts` |
| 3-2 | JSON 형식에서 `executor`, `executor_reason`, `openclaw_params` 필드 제거 | `packages/electron-app/src/app/api/missions/route.ts` |

### Phase 4: 미션 실행 통합 (파일 1개)

| 순서 | 작업 | 파일 |
|------|------|------|
| 4-1 | `RoutingEntry` 타입에서 `executor`, `executor_reason`, `openclaw_params` 제거 | `packages/electron-app/src/app/api/missions/[id]/run/route.ts` |
| 4-2 | executor 분기 제거 - 전부 `agentRun()` 사용 | `packages/electron-app/src/app/api/missions/[id]/run/route.ts` |
| 4-3 | `callClaude()` 함수 삭제 | `packages/electron-app/src/app/api/missions/[id]/run/route.ts` |
| 4-4 | `runAgentTask()` 함수 삭제 (인라인 대체) | `packages/electron-app/src/app/api/missions/[id]/run/route.ts` |
| 4-5 | `buildOpenClawPrompt()` 함수 삭제 | `packages/electron-app/src/app/api/missions/[id]/run/route.ts` |
| 4-6 | `consolidateResults()`를 `agentRun()` 사용으로 변경 | `packages/electron-app/src/app/api/missions/[id]/run/route.ts` |
| 4-7 | 불필요한 import 제거 (`CLAUDE_CLI`, `execFile`, `promisify` 등) | `packages/electron-app/src/app/api/missions/[id]/run/route.ts` |

### Phase 5: Gateway 안정성 강화 (파일 1개)

| 순서 | 작업 | 파일 |
|------|------|------|
| 5-1 | `ensureGatewayReady()` 함수 추가 | `packages/electron-app/src/lib/gateway-manager.ts` |
| 5-2 | 미션 실행 전 Gateway 준비 상태 확인 로직 추가 | `packages/electron-app/src/app/api/missions/[id]/run/route.ts` |

### Phase 6: 테스트 (신규 2개)

| 순서 | 작업 | 파일 |
|------|------|------|
| 6-1 | 통합 실행 인터페이스 테스트 | `packages/electron-app/src/__tests__/openclaw-executor-unified.test.ts` |
| 6-2 | 미션 실행 통합 테스트 | `packages/electron-app/src/__tests__/missions-run-unified.test.ts` |

### Phase 7: 문서화

| 순서 | 작업 | 파일 |
|------|------|------|
| 7-1 | README에 아키텍처 다이어그램 갱신 (오케스트레이터 + OpenClaw 2계층) | `README.md` |

---

## 7. 주의사항

### 7.1 보안

- `agentRun()`에 `extraEnv`로 vault 시크릿을 전달할 때, Gateway HTTP 요청 body에 시크릿이 포함되지 않도록 한다. `extraEnv`는 CLI 폴백 경로에서만 사용하고, Gateway 경로에서는 Gateway 프로세스의 환경변수로 전달한다 (이미 `gateway-manager.ts`에서 처리)
- `--permission-mode bypassPermissions` 플래그는 CLI 백엔드 설정(`cli-backend.ts`)에서만 관리. 호출자가 직접 지정하지 않도록 한다
- Gateway loopback 바인딩(`127.0.0.1`)을 유지하여 외부 접근 차단
- 오케스트레이터의 `CLAUDE_CLI` 직접 호출 시에도 `ANTHROPIC_API_KEY`를 환경변수에 포함하지 않음 (기존 패턴 유지)

### 7.2 호환성

- **기존 미션 데이터**: DB에 저장된 기존 routing JSON에 `executor` 필드가 있을 수 있음. 파싱 시 무시하면 됨 (`executor` 필드를 읽지 않으므로 하위호환 자동 유지)
- **기존 openclaw_params**: `openclaw_params` 중첩 객체가 있는 기존 데이터는 마이그레이션 불필요. 파싱 시 `r.thinking || r.openclaw_params?.thinking` 패턴으로 양쪽 지원
- **mission-runner.ts**: 백그라운드 미션 러너도 동일하게 변경 필요. 이 명세서의 범위에 포함
- **오케스트레이터 하위호환**: `route.ts`의 실행 방식이 유지되므로 라우팅 분석 기능에 대한 하위호환 자동 보장

### 7.3 경로/환경

- Gateway 프로세스의 `cwd`와 에이전트 작업의 `cwd`는 다를 수 있음. `openclaw` 확장 필드의 `cwd`를 CLI 백엔드가 spawn 시 반영해야 함
- Gateway가 `CLAUDE_CLI_PATH` 환경변수를 받아서 CLI 백엔드에 전달해야 함 (Phase 1에서 처리)

### 7.4 타이밍/동시성

- Gateway 미가동 상태에서 미션 실행 시작 -> `ensureGatewayReady()`가 최대 30초 대기 -> 실패 시 CLI 폴백
- 여러 에이전트가 동시에 실행되면 Gateway를 통해 여러 `claude` 프로세스가 spawn됨 -> 구독 플랜의 동시 세션 제한 주의
- 라우팅 분석(오케스트레이터)은 Claude CLI 직접 호출이므로 Gateway 상태와 무관하게 동작

### 7.5 엣지 케이스

- **Gateway 미설치/미빌드**: `findOpenClawBinary()` 실패 -> `agentRunViaCli()`에서 `CLAUDE_CLI`로 직접 폴백
- **Claude CLI 미설치**: 오케스트레이터 단계에서 이미 실패하므로 미션 생성 자체가 불가 (기존 동작 유지)
- **대용량 프롬프트**: CLI 폴백의 `maxBuffer: 10MB` 제한 유지. Gateway 경로는 스트리밍이므로 제한 없음
- **기존 executor='c3' 미션 재실행**: `executor` 필드를 읽지 않으므로 자동으로 OpenClaw 경로로 실행됨

### 7.6 한계/향후 과제

- **Gateway cwd 전달**: OpenClaw Gateway의 `/v1/chat/completions` API가 `openclaw.cwd` 확장 필드를 CLI 백엔드의 spawn `cwd` 옵션으로 전달하는 기능이 필요. 현재 OpenClaw에 이 기능이 없으면 CLI 폴백에서만 `cwd`가 적용됨 -> Gateway 측 기능 추가 또는 프롬프트에 `cd` 명령 포함으로 우회
- **MCP 설정 전달**: Gateway 경로에서 MCP 설정 파일을 CLI 백엔드에 전달하는 메커니즘 필요. 현재는 CLI 폴백에서만 `--mcp-config` 적용
- **멀티턴 대화**: 현재 모든 에이전트 작업이 단일 턴. 향후 세션 기반 멀티턴 대화 지원 시 OpenClaw의 세션 관리 기능 활용 가능
- **mission-runner.ts 정합성**: 백그라운드 미션 러너(스케줄러 실행)도 동일한 패턴으로 전환 필요

---

## 8. 기대 효과

### 전환 전 (현재)

```
사용자: "코드 리뷰 + 슬랙으로 결과 보내줘"
시스템:
  1. Claude CLI가 라우팅 분석 -> executor 결정
  2. 코드 리뷰 -> executor='c3' -> electron-app이 직접 Claude CLI spawn
  3. 슬랙 전송 -> executor='openclaw' -> Gateway -> SDK 호출 실패
결과: 부분 실패, 이중 경로 유지보수 부담
```

### 전환 후

```
사용자: "코드 리뷰 + 슬랙으로 결과 보내줘"
시스템:
  1. Claude CLI가 라우팅 분석 (오케스트레이터, 직접 호출 유지)
  2. 코드 리뷰 -> agentRun() -> Gateway -> claude CLI spawn -> 완료
  3. 슬랙 전송 -> agentRun() -> Gateway -> 채널 전송 -> 완료
결과: 전부 성공, 오케스트레이터 외 단일 경로, 구독제 무과금
```

### 후속 기능

- 미션 실행 경로가 단순화되어 로깅, 모니터링, 디버깅이 용이
- OpenClaw Gateway의 세션 관리, 채널 전송, 스케줄링 기능을 모든 에이전트 작업에서 활용 가능
- 오케스트레이터(라우팅 분석)는 독립적이므로, 향후 오케스트레이터 자체의 개선(멀티모달 분석 등)이 실행 경로에 영향 없이 가능
- vm-server 기반 분산 실행 전환 시 Gateway가 유일한 추론 엔드포인트이므로 전환 용이
- `electron-app`에서 `claude-cli.ts` 의존성이 오케스트레이터 전용으로 축소됨 (실행 경로에서 제거)

---

## 9. 파일 변경 요약

| 파일 | 작업 | 설명 |
|------|------|------|
| `packages/electron-app/src/lib/openclaw-executor.ts` | **수정** | AgentRunParams 확장, agentRunViaGateway 고도화, agentRunViaCli 확장 |
| `packages/electron-app/src/lib/openclaw-client.ts` | **수정** | GatewayRequestOptions에 openclaw 확장 필드 추가 |
| `packages/electron-app/src/lib/gateway-manager.ts` | **수정** | ensureGatewayReady() 함수 추가 |
| `packages/electron-app/src/app/api/missions/route.ts` | **수정** | 라우팅 프롬프트에서 executor 관련 내용 제거 (실행 방식은 유지) |
| `packages/electron-app/src/app/api/missions/[id]/run/route.ts` | **수정** | executor 분기 제거, callClaude/runAgentTask/buildOpenClawPrompt 삭제, consolidateResults 전환 |
| `packages/electron-app/src/__tests__/openclaw-executor-unified.test.ts` | **신규** | 통합 실행 인터페이스 테스트 |
| `packages/electron-app/src/__tests__/missions-run-unified.test.ts` | **신규** | 미션 실행 통합 테스트 |
| `README.md` | **수정** | 오케스트레이터 + OpenClaw 2계층 아키텍처 반영 |

총 **2개 신규**, **6개 수정**
