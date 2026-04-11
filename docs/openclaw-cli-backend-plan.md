# OpenClaw Claude CLI 백엔드 전환 계획

> OpenClaw이 Anthropic API(`@anthropic-ai/sdk`)를 직접 호출하는 대신,  
> AI Hub의 c3처럼 로컬 `claude` CLI 바이너리를 spawn하여 구독제 인증을 사용하도록 전환

## 1. 배경 및 동기

### 현재 상태
- OpenClaw의 추론 경로: `anthropic-transport-stream.ts` → `@anthropic-ai/sdk` → `client.messages.stream()` → **Anthropic API 직접 호출**
- 인증: **setup-token** (`sk-ant-oat01-*`) 또는 API key → **모두 API 과금 (토큰당 비용)**
- Anthropic 정책 변경으로 setup-token **폐기** → Gateway 500 에러 발생

### 핵심 문제: 비용 모델
| 방식 | 인증 | 비용 모델 |
|------|------|-----------|
| API 직접 호출 (현재) | setup-token / API key | **토큰당 과금** (사용한 만큼) |
| Claude CLI 바이너리 (목표) | `claude auth login` | **구독제** (Pro/Max 정액) |

**토큰 기반 인증은 어떤 것이든 (setup-token, API key, OAuth) 결국 API 과금이므로 의미 없음.**

### 목표
- AI Hub c3와 동일하게: `spawn('claude', args)` → 로컬 바이너리의 구독 인증 재사용
- API 키/토큰 관리 완전 제거
- Gateway 500 문제 근본 해결

### AI Hub c3 참고 구현 (`electron-app`)
```
사용자 요청 → spawn(CLAUDE_CLI, args) → stdout 스트리밍 → 응답
```
- `src/lib/claude-cli.ts`: 바이너리 탐색 (`CLAUDE_CLI_PATH` → `which` → 글로벌 경로 → fallback)
- `src/app/api/claude/[agentId]/route.ts`: spawn + stdout 스트리밍 → ReadableStream
- `src/lib/mission-runner.ts`: execFileAsync + 5분 타임아웃 (배치 실행)
- 인증: CLI 내부 상태 의존 (`claude auth login` 사전 실행 필요)
- API 키를 전혀 전달하지 않음

---

## 2. 현재 OpenClaw 추론 경로 (변경 대상)

### 핵심 파일: `anthropic-transport-stream.ts` (~865 lines)

현재 추론 흐름:
```
createAnthropicTransportClient()          -- SDK 클라이언트 생성
  └─ new Anthropic({ apiKey, authToken, baseURL })
       │
buildAnthropicParams()                    -- 요청 파라미터 조립
  └─ model, messages, system, tools, thinking
       │
createAnthropicMessagesTransportStreamFn() -- 스트리밍 실행
  └─ client.messages.stream(params)
       └─ on('message_start' | 'content_block_delta' | ...)
```

**이 전체 경로가 SDK API 호출.** CLI 바이너리 spawn으로 교체 필요.

### 기타 API 호출 지점

| 파일 | 역할 | 비고 |
|------|------|------|
| `anthropic-vertex-stream.ts` | GCP Vertex AI 경로 | GCP 전용, CLI 전환 대상 외 |
| `provider-usage.fetch.claude.ts` | 사용량 조회 (claude.ai HTTP) | 추론과 무관, 별도 처리 |

### 인증 관련 파일

| 파일 | 현재 역할 |
|------|-----------|
| `extensions/anthropic/register.runtime.ts` | setup-token / API key / CLI 3가지 인증 등록 |
| `extensions/anthropic/cli-auth-seam.ts` | Claude CLI 크리덴셜 읽기 (참고용) |
| `src/plugins/provider-auth-token.ts` | `sk-ant-oat01-` 프리픽스 정의 |
| `src/secrets/provider-env-vars.ts` | `ANTHROPIC_API_KEY` 환경변수 |
| `.env.example` | API 키 예시 |

> **참고**: `cli-backend.ts`에 `CliBackendPlugin` 설정이 존재하지만, 이것은 OpenClaw 플러그인 시스템의 **설정 정의**일 뿐 실제 추론 경로에서 사용되지 않음. 현재 추론은 전부 `anthropic-transport-stream.ts`의 SDK 경로를 탐.

---

## 3. 구현 계획

### Phase 1: OpenClaw에 Claude CLI 실행 모듈 추가

**목표**: c3의 `claude-cli.ts`와 동일한 패턴으로 OpenClaw 내부에 CLI 실행 기능 구축

#### 1-1. Claude 바이너리 탐색기 (신규)

c3의 `claude-cli.ts` 패턴을 OpenClaw에 이식:

```typescript
// packages/openclaw/src/agents/claude-cli-runner.ts (신규)

// 1) 바이너리 탐색 (c3 패턴 동일)
function findClaudeBinary(): string {
  // CLAUDE_CLI_PATH 환경변수 → which claude → 글로벌 경로들 → fallback
}

// 2) 스트리밍 실행 (spawn)
function spawnClaudeStream(params: {
  prompt: string;
  model?: string;
  tools?: string[];
  systemPrompt?: string;
  sessionId?: string;
  cwd?: string;
  timeout?: number;
}): { process: ChildProcess; stream: ReadableStream }

// 3) 배치 실행 (execFile)
async function execClaude(params: {
  prompt: string;
  model?: string;
  timeout?: number;
}): Promise<string>
```

#### 1-2. CLI → 스트림 이벤트 변환기 (신규)

`claude --output-format stream-json`의 JSONL 출력을 OpenClaw 내부 스트림 이벤트로 변환:

```typescript
// CLI 출력 (JSONL):
// {"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}

// → OpenClaw 내부 이벤트:
// { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }
```

### Phase 2: 추론 경로 분기 (API → CLI)

**목표**: `anthropic-transport-stream.ts`에 CLI 경로 분기 추가

#### 2-1. Transport 함수 CLI 분기

```typescript
// anthropic-transport-stream.ts 수정

export function createAnthropicMessagesTransportStreamFn(...) {
  // CLI 모드 감지
  if (isCliBackendMode(model)) {
    return createCliTransportStreamFn(model, ...);  // 신규 CLI 경로
  }
  // 기존 SDK 경로 (폴백)
  return createSdkTransportStreamFn(model, ...);
}
```

#### 2-2. CLI Transport 구현

```typescript
function createCliTransportStreamFn(...) {
  const { process, stream } = spawnClaudeStream({
    prompt: messages,
    model: model.id,
    tools: toolDefinitions,
    systemPrompt: systemPrompt,
  });

  // JSONL → OpenClaw 스트림 이벤트 변환
  return transformCliOutputToStreamEvents(stream);
}
```

### Phase 3: AI Hub 연동 수정

**목표**: electron-app에서 OpenClaw이 CLI 모드로 동작하도록 연결

#### 3-1. Gateway 환경 설정

```typescript
// gateway-manager.ts 수정
// Gateway 시작 시 CLI 모드 환경변수 전달
env: {
  OPENCLAW_ANTHROPIC_BACKEND: 'cli',  // CLI 모드 활성화
  CLAUDE_CLI_PATH: CLAUDE_CLI,        // 바이너리 경로 전달
  // ANTHROPIC_API_KEY 제거
}
```

#### 3-2. openclaw-executor.ts 수정

```typescript
// Gateway 없을 때 직접 실행도 CLI 모드
export async function agentRun(params) {
  if (await isGatewayReady()) {
    // Gateway가 CLI 모드로 실행 중 → 그대로 HTTP 호출
    return agentRunViaGateway(params);
  }
  // 직접 CLI 실행 (기존 openclaw CLI가 아닌 claude CLI 직접)
  return agentRunViaCli(params);
}
```

#### 3-3. 미션 오케스트레이터 업데이트

- `mission-runner.ts`: OpenClaw executor 호출 시 CLI 모드 보장
- `[id]/run/route.ts`: SSE 스트리밍에서 CLI 출력 호환

### Phase 4: 인증 및 설정 정리

**목표**: API 키 기반 인증 제거, CLI 인증 단일화

1. **OpenClaw 설정 변경**
   - 기본 백엔드를 CLI로 설정
   - setup-token / API key 인증을 선택사항(옵트인)으로 변경

2. **환경변수 정리**
   - `ANTHROPIC_API_KEY` → 불필요 (제거 또는 선택사항)
   - `CLAUDE_CLI_PATH` → 문서화 (선택사항, 자동 탐색 우선)

3. **setup-token 비활성화**
   - `register.runtime.ts`에서 setup-token deprecated 경고
   - `openclaw doctor`에서 CLI 전환 자동 안내

### Phase 5: 테스트

1. **CLI 실행 모듈 테스트**
   - 바이너리 탐색 로직
   - JSONL 파싱 + 스트림 이벤트 변환
   - 타임아웃, 에러 핸들링

2. **추론 경로 통합 테스트**
   - 프롬프트 → CLI spawn → 응답 수신 e2e
   - 도구 사용 라운드트립
   - 세션 재개

3. **AI Hub 통합 테스트**
   - 미션 → 오케스트레이터 → OpenClaw CLI 모드 → 결과

---

## 4. 핵심 기술 결정사항

### Q1: CLI 출력 형식
- `claude -p --output-format stream-json --include-partial-messages` 사용
- 출력: JSONL (한 줄 = 한 JSON 객체)
- `--verbose` 플래그로 thinking 과정 포함

### Q2: 도구 사용 (Tool Use)
- `--allowedTools Edit,Write,Read,Bash` 형태로 전달
- `--dangerously-skip-permissions` 플래그로 자동 승인
- 도구 결과 피드백: `--continue` + stdin

### Q3: 모델 선택
- `--model claude-sonnet-4-6` 형태로 전달
- CLI가 내부적으로 구독 플랜에 맞는 모델 사용

### Q4: 동시 실행
- 각 요청마다 별도 `claude` 프로세스 spawn
- 구독 플랜의 동시 실행 제한에 주의 (Pro: 제한적, Max: 여유)
- 필요시 큐잉 구현

### Q5: Vertex AI
- GCP 환경은 CLI 전환 대상 외
- 기존 API 키 방식 유지

---

## 5. 리스크 및 대응

| 리스크 | 영향 | 대응 |
|--------|------|------|
| `claude` 바이너리 미설치 | 추론 불가 | 시작 시 존재 확인 + 설치 안내 |
| 구독 플랜 동시 실행 제한 | 요청 큐잉 필요 | 프로세스 풀 + 대기열 |
| CLI 출력 형식 변경 | 파싱 실패 | `@anthropic-ai/claude-code` 버전 고정 |
| 프로세스 시작 오버헤드 | 첫 토큰 지연 | 허용 가능 (1-2초) |
| `claude auth login` 미실행 | 인증 실패 | 시작 시 인증 상태 확인 + 안내 |

---

## 6. 작업 우선순위

```
Phase 1 (CLI 실행 모듈)   ━━━━━━━━ 최우선 — 핵심 기능, 신규 개발
Phase 2 (추론 경로 분기)  ━━━━━━━━ 바로 연속 — Phase 1 결과물 연결
Phase 3 (AI Hub 연동)    ━━━━━━   즉시 효과 — Gateway 500 해결
Phase 4 (인증 정리)      ━━━━     후순위 — 레거시 제거
Phase 5 (테스트)         ━━━━━━━━ 각 Phase 병행
```

---

## 7. 파일 변경 요약

### 신규 생성
- `packages/openclaw/src/agents/claude-cli-runner.ts` — CLI 실행 + 바이너리 탐색
- `packages/openclaw/src/agents/claude-cli-stream-adapter.ts` — JSONL → 스트림 이벤트 변환

### 핵심 수정
- `packages/openclaw/src/agents/anthropic-transport-stream.ts` — CLI 경로 분기 추가
- `packages/electron-app/src/lib/gateway-manager.ts` — CLI 모드 환경변수 전달
- `packages/electron-app/src/lib/openclaw-executor.ts` — CLI 모드 보장

### 설정 수정
- `packages/openclaw/extensions/anthropic/register.runtime.ts` — 기본 백엔드 CLI 전환
- `packages/openclaw/.env.example` — API 키 → CLI 경로 (선택사항)

### 정리 대상
- `packages/openclaw/src/plugins/provider-auth-token.ts` — setup-token deprecated
- `packages/openclaw/src/secrets/provider-env-vars.ts` — API 키 변수 정리
