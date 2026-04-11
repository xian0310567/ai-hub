# OpenClaw Claude CLI 백엔드 전환 계획

> OpenClaw이 Anthropic API(`@anthropic-ai/sdk`)를 직접 호출하는 대신,  
> 로컬에 설치된 `claude` CLI 바이너리를 호출하도록 변경하는 마이그레이션 계획

## 1. 배경 및 동기

### 현재 문제
- OpenClaw은 `@anthropic-ai/sdk`를 통해 Anthropic API에 직접 요청
- 인증에 **setup-token** (`sk-ant-oat01-*`) 사용 → Anthropic 정책 변경으로 **폐기(deprecated)**
- API 과금 기반으로 전환됨 → setup-token으로는 더 이상 정상 작동 불가
- Gateway 500 에러의 근본 원인

### 목표
- AI Hub의 c3가 `claude` CLI를 호출하는 것과 동일한 방식으로 OpenClaw도 전환
- `claude` CLI의 내부 인증(`claude auth login`)을 그대로 활용
- API 키 관리 부담 제거, 로컬 환경의 인증 상태 재사용

### 참고 구현: AI Hub c3 패턴
```
사용자 요청 → spawn(CLAUDE_CLI, args) → stdout 스트리밍 → 응답
```
- 바이너리 탐색: `CLAUDE_CLI_PATH` → `which claude` → 글로벌 경로들 → fallback
- 인증: CLI 내부 상태 (`claude auth login` 사전 실행 필요)
- 스트리밍: `spawn()` + `stdout.on('data')` → `ReadableStream`
- 배치: `execFileAsync()` + 5분 타임아웃 + 10MB 버퍼

---

## 2. 영향 범위 분석

### 2.1 핵심 변경 대상 (API 직접 호출)

| 파일 | 역할 | 변경 내용 |
|------|------|-----------|
| `packages/openclaw/src/agents/anthropic-transport-stream.ts` | **핵심** — SDK 스트리밍 추론 | `client.messages.stream()` → `claude` CLI 서브프로세스로 교체 |
| `packages/openclaw/src/agents/anthropic-vertex-stream.ts` | Vertex AI 라우팅 | GCP 경로도 CLI 백엔드 대안 필요 |

### 2.2 인증 체계 변경

| 파일 | 역할 | 변경 내용 |
|------|------|-----------|
| `packages/openclaw/extensions/anthropic/register.runtime.ts` | 프로바이더 등록 + 인증 | setup-token 인증 → CLI 인증 우선으로 변경 |
| `packages/openclaw/extensions/anthropic/cli-backend.ts` | **이미 CLI 백엔드 구현 존재** | 기존 구현 확장/활용 |
| `packages/openclaw/extensions/anthropic/cli-auth-seam.ts` | CLI 인증 연동 | `readClaudeCliCredentialsForRuntime()` 활용 |
| `packages/openclaw/extensions/anthropic/cli-shared.ts` | CLI 공유 상수 | 명령어 인자, 모델 별칭 등 |
| `packages/openclaw/src/plugins/provider-auth-token.ts` | setup-token 프리픽스 | `sk-ant-oat01-` 관련 코드 정리 |

### 2.3 설정 및 환경변수

| 파일 | 역할 | 변경 내용 |
|------|------|-----------|
| `packages/openclaw/.env.example` | 환경변수 예시 | `ANTHROPIC_API_KEY` → `CLAUDE_CLI_PATH` (선택) |
| `packages/openclaw/src/infra/dotenv.ts` | 보호 변수 목록 | API 키 관련 항목 재검토 |
| `packages/openclaw/src/secrets/provider-env-vars.ts` | 프로바이더 환경변수 | anthropic 프로바이더 변수 재정의 |

### 2.4 사용량 추적 (별도 처리)

| 파일 | 역할 | 변경 내용 |
|------|------|-----------|
| `packages/openclaw/src/infra/provider-usage.fetch.claude.ts` | Claude 사용량 조회 | 별도 HTTP 호출이므로 CLI 전환과 독립적으로 처리 |

### 2.5 기존 CLI 백엔드 (이미 존재!)

**중요 발견**: OpenClaw에는 이미 `cli-backend.ts`에 Claude CLI 백엔드가 구현되어 있음.

```typescript
// extensions/anthropic/cli-backend.ts
export function buildAnthropicCliBackend(): CliBackendPlugin {
  return {
    id: CLAUDE_CLI_BACKEND_ID,
    config: {
      command: "claude",
      args: ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
             "--setting-sources", "user", "--permission-mode", "bypassPermissions"],
      resumeArgs: ["--resume", "{sessionId}"],
      output: "jsonl",
      input: "stdin",
      modelArg: "--model",
      sessionArg: "--session-id",
      // ...
    },
  };
}
```

**그리고 `register.runtime.ts`에 CLI 인증 경로도 이미 등록:**
```typescript
auth: [
  { id: "cli", label: "Claude CLI", hint: "Reuse a local Claude CLI login..." },
  { id: "setup-token", ... },  // ← deprecated
  { id: "api-key", ... },
]
```

→ **기존 CLI 백엔드를 기본(default)으로 전환하는 것이 핵심 작업**

---

## 3. 구현 단계

### Phase 1: CLI 백엔드를 기본값으로 설정 (설정 변경)

**목표**: OpenClaw이 기본적으로 `claude` CLI를 사용하도록 설정 전환

1. **`register.runtime.ts`에서 인증 우선순위 변경**
   - `cli` 인증 방법의 `assistantPriority`를 최우선으로 상향
   - `setup-token`의 `assistantPriority`를 낮추거나 deprecated 표시
   - 기본 모델 참조를 `claude-cli/*`로 변경

2. **AI Hub 설정 파일 (`openclaw.yaml` 등) 수정**
   - `agents.defaults.model.primary` → `claude-cli/claude-sonnet-4-6`
   - 인증 프로필을 `cli` 모드로 설정

3. **환경 감지 로직 추가**
   - `claude` 바이너리 존재 여부 확인 → 있으면 CLI 백엔드 자동 선택
   - 없으면 기존 API 키 방식 유지 (폴백)

### Phase 2: anthropic-transport-stream CLI 경로 강화

**목표**: SDK 스트리밍이 아닌 CLI 서브프로세스로 추론 실행

1. **`createAnthropicTransportClient()` 분기 추가** (line 392-473)
   - CLI 백엔드 모드일 때 SDK 클라이언트 대신 CLI 래퍼 반환
   - 기존 `buildAnthropicCliBackend()` 설정 재활용

2. **`createAnthropicMessagesTransportStreamFn()` CLI 경로** (line 595-865)
   - `client.messages.stream()` 대신 `spawn('claude', args)` 호출
   - CLI의 `--output-format stream-json` 출력을 기존 스트림 이벤트로 변환
   - 매핑: CLI JSON 라인 → `message_start`, `content_block_delta`, etc.

3. **도구 사용(Tool Use) 호환**
   - CLI의 `--allowedTools` 인자로 도구 전달
   - 도구 실행 결과 stdin을 통한 피드백 (기존 `input: "stdin"` 설정 활용)

### Phase 3: AI Hub 연동 계층 수정

**목표**: electron-app에서 OpenClaw을 CLI 모드로 호출

1. **`openclaw-executor.ts` 수정**
   - Gateway 호출 시에도 CLI 백엔드 모드가 적용되도록 설정 전달
   - Gateway 없을 때 직접 CLI 폴백 유지

2. **`gateway-manager.ts` 수정**
   - Gateway 시작 시 CLI 백엔드 모드 환경변수 전달
   - `ANTHROPIC_API_KEY` 대신 CLI 인증 상태 확인

3. **미션 오케스트레이터 업데이트**
   - `mission-runner.ts`와 `[id]/run/route.ts`의 OpenClaw 에이전트 실행이 CLI 모드 사용

### Phase 4: setup-token 인증 경로 정리

**목표**: deprecated 인증 경로 비활성화 및 마이그레이션 안내

1. **setup-token 인증 deprecated 마크**
   - `register.runtime.ts`의 setup-token 방법에 deprecated 경고 추가
   - 사용 시 CLI 인증으로 전환 안내 메시지

2. **마이그레이션 doctor 명령어**
   - `openclaw doctor` 실행 시 setup-token → CLI 전환 자동 제안
   - `openclaw models auth login --provider anthropic --method cli` 안내

3. **환경변수 정리**
   - `.env.example`에서 `ANTHROPIC_API_KEY` 관련 항목 선택사항으로 변경
   - `CLAUDE_CLI_PATH` 환경변수 문서화

### Phase 5: 테스트 및 검증

1. **단위 테스트**
   - CLI 백엔드 기본 선택 로직 테스트
   - 스트리밍 출력 변환 테스트
   - 바이너리 탐색 테스트

2. **통합 테스트**
   - 에이전트 실행 e2e: 미션 → CLI 호출 → 응답
   - 세션 재개 테스트
   - 도구 사용 라운드트립 테스트

3. **폴백 테스트**
   - `claude` 바이너리 미설치 시 API 키 폴백
   - CLI 프로세스 크래시 시 에러 핸들링

---

## 4. 핵심 기술 결정사항

### Q1: CLI 출력 파싱
- `--output-format stream-json`은 JSON Lines 형식
- 기존 `cli-backend.ts`에 `output: "jsonl"` 설정 존재
- OpenClaw 내부의 `CliBackendPlugin` 인프라가 이미 파싱 처리

### Q2: 도구 사용 (Tool Use)
- CLI는 `--allowedTools` 플래그로 도구 목록 전달
- 도구 실행 결과는 stdin 피드백 (CLI의 대화형 모드)
- 이미 `input: "stdin"` 설정으로 구현 가능

### Q3: 사고(Thinking) 모드
- CLI에서 `--verbose` 플래그로 사고 과정 포함
- 적응형 사고는 모델에 의해 자동 처리

### Q4: Vertex AI 경로
- Vertex는 GCP 인프라 의존적이므로 CLI 전환 대상에서 제외
- 클라우드 환경은 기존 API 키 방식 유지

### Q5: 프롬프트 캐시
- CLI 백엔드에서는 프롬프트 캐시가 CLI 내부적으로 관리됨
- `cache_control` 헤더 직접 관리 불필요

---

## 5. 리스크 및 대응

| 리스크 | 영향 | 대응 |
|--------|------|------|
| `claude` 바이너리 미설치 | 에이전트 실행 불가 | API 키 폴백 유지 + 설치 안내 |
| CLI 버전 호환성 | 출력 형식 변경 가능 | `@anthropic-ai/claude-code` 버전 고정 |
| 동시 실행 제한 | CLI 프로세스 수 제한 | 큐잉 + 동시 실행 수 제한 |
| 세션 관리 | CLI 세션 vs Gateway 세션 | `--session-id` 플래그로 통합 |
| 스트리밍 지연 | 프로세스 시작 오버헤드 | 웜업 불필요, 첫 토큰 지연 허용 |

---

## 6. 작업 우선순위

```
Phase 1 (설정 전환)     ━━━━━━━━ 최우선 — 기존 코드 활용, 변경 최소
Phase 3 (AI Hub 연동)   ━━━━━━━━ 즉시 효과 — 현재 Gateway 500 해결
Phase 2 (스트리밍 강화)  ━━━━━━   중기 — 안정성 향상
Phase 4 (정리)          ━━━━     후순위 — 레거시 제거
Phase 5 (테스트)        ━━━━━━━━ 각 Phase 완료 시 병행
```

**Phase 1이 가장 빠르고 효과적인 이유:**
- OpenClaw에 CLI 백엔드가 **이미 구현되어 있음** (`cli-backend.ts`)
- CLI 인증 연동도 **이미 존재** (`cli-auth-seam.ts`)
- 단순히 **기본값을 CLI로 전환**하면 setup-token 문제 해결
- AI Hub 설정만 변경하면 즉시 적용 가능

---

## 7. 파일 변경 요약

### 반드시 수정
- `packages/openclaw/extensions/anthropic/register.runtime.ts` — 인증 우선순위
- `packages/electron-app/src/lib/openclaw-executor.ts` — CLI 모드 전달
- `packages/electron-app/src/lib/gateway-manager.ts` — CLI 환경 설정
- AI Hub OpenClaw 설정 파일 — 기본 백엔드 변경

### 조건부 수정
- `packages/openclaw/src/agents/anthropic-transport-stream.ts` — CLI 분기 추가
- `packages/openclaw/src/agents/anthropic-vertex-stream.ts` — GCP 환경만 해당
- `packages/openclaw/.env.example` — 환경변수 업데이트
- `packages/openclaw/src/infra/dotenv.ts` — 보호 변수 목록

### 정리 대상 (Phase 4)
- `packages/openclaw/src/plugins/provider-auth-token.ts` — setup-token 코드
- `packages/openclaw/src/secrets/provider-env-vars.ts` — API 키 변수
- `packages/openclaw/src/infra/provider-usage.fetch.claude.ts` — 사용량 추적
