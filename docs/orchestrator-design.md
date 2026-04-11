# 미션 오케스트레이터 설계 명세서

> **목적**: 사용자는 미션만 입력한다. 시스템이 Claude CLI(c3)와 OpenClaw 중 적절한 실행 수단을 자동으로 판단하여 미션을 완료한다.
>
> **작성일**: 2026-04-11

---

## 1. 왜 필요한가

### 1.1 현재 문제

현재 미션 시스템은 **모든 작업을 Claude CLI(`execFile`)로만 실행**한다.

```
사용자 → "내일 아침 10시에 뉴스 분석해줘"
       → Claude CLI 실행
       → "저는 스케줄을 설정할 수 없습니다" 라는 보고서 반환
```

OpenClaw 게이트웨이가 로컬에서 실행 중임에도 불구하고, 미션 시스템은 이를 전혀 활용하지 않는다. OpenClaw에는 네이티브 크론 스케줄러, 채널 전송, 세션 관리 등 미션 실행에 필수적인 인프라가 있지만, 현재는 프로세스 시작/중지/상태 확인 용도로만 연결되어 있다.

### 1.2 목표 상태

```
사용자 → "내일 아침 10시에 뉴스 분석해줘"
       → 오케스트레이터가 분석
       → OpenClaw cron add (스케줄 등록)
       → OpenClaw agent 또는 c3 (뉴스 수집·분석 실행)
       → 완료 보고
```

사용자는 c3인지 OpenClaw인지 알 필요 없다. 오케스트레이터가 판단한다.

### 1.3 c3와 OpenClaw를 모두 유지하는 이유

| 기준 | c3 (Claude CLI) | OpenClaw |
|------|-----------------|----------|
| **실행 모델** | 프로세스 1개 → 끝 | 게이트웨이 상주 서버 |
| **파일 접근** | 로컬 FS 직접 접근 | 게이트웨이 경유 |
| **의존성** | 없음 (독립 프로세스) | 게이트웨이 필수 |
| **장애 영향** | 해당 잡만 실패 | 게이트웨이 다운 시 전체 영향 |
| **스케줄링** | 불가 | 네이티브 크론 |
| **채널 전송** | 불가 | Slack, Discord, Telegram 등 24+ |
| **세션 영속** | 파일 기반 (제한적) | 네이티브 세션 관리 |
| **적합한 작업** | 코드 수정, 파일 분석, 즉시 실행 | 예약, 반복, 외부 전송, 대화형 |

**c3 = 일꾼** (가볍고 빠르고 독립적), **OpenClaw = 인프라** (스케줄링, 라우팅, 전송)

OpenClaw만 쓰면 단순 파일 작업에도 게이트웨이 의존성이 생기고, 게이트웨이 장애 시 모든 미션이 멈춘다. c3만 쓰면 스케줄링과 외부 전송이 불가능하다.

---

## 2. 현재 아키텍처 분석

### 2.1 미션 실행 흐름 (현재)

```
POST /api/missions { task }
  ↓
Claude CLI로 라우팅 분석 (조직도 + 태스크 → JSON)
  ↓
routing: [{ agent_id, subtask, gate_type }]
  ↓
POST /api/missions/{id}/run
  ↓
Promise.allSettled(routing.map(agent => {
  waitForTurn(agent)           // 에이전트별 큐 대기
  → humanGate(if needed)       // 승인 대기
  → callClaude(prompt, cwd)    // execFile('claude', ['-p', ...])
  → scoreJob(result)           // 품질 채점
}))
  ↓
consolidateResults()            // Claude로 통합 보고서 생성
```

**핵심 파일:**

| 파일 | 역할 |
|------|------|
| `src/app/api/missions/route.ts` | 미션 생성 + 라우팅 분석 |
| `src/app/api/missions/[id]/run/route.ts` | SSE 기반 미션 실행 |
| `src/lib/mission-runner.ts` | 백그라운드 미션 실행 (스케줄러용) |
| `src/lib/claude-cli.ts` | Claude CLI 경로 탐색 + 환경 구성 |
| `src/lib/openclaw-client.ts` | OpenClaw Gateway HTTP 클라이언트 |
| `src/lib/gateway-manager.ts` | OpenClaw 프로세스 관리 |
| `server.ts` | 미션 스케줄러 (setInterval 60초 폴링) |

### 2.2 OpenClaw 현재 활용도

```
gateway-manager.ts → startGateway() / stopGateway()    // 프로세스 관리
openclaw-client.ts → isGatewayAvailable()               // 헬스체크
                   → sendToGateway()                     // 채팅용 (미사용)
OpenClawStatus.tsx → UI 상태 표시                        // 팝오버
```

**미사용 중인 OpenClaw 기능:**
- `openclaw cron add/list/run` — 네이티브 스케줄러
- `openclaw agent -m "..."` — 에이전트 실행
- Gateway `/v1/chat/completions` — OpenAI 호환 API
- Gateway WebSocket `cron.add/list/run` — 크론 관리
- 채널 전송 (Slack, Discord, Telegram 등)
- 세션 관리 (영속적 대화 컨텍스트)

### 2.3 기존 이중 모드 패턴 (참고용)

`src/app/api/chat/[agentId]/route.ts`에 Gateway 우선 + CLI 폴백 패턴이 이미 존재한다:

```typescript
if (await isGatewayAvailable()) {
  // Gateway SSE로 실행
  // 실패 시 → CLI 폴백
} else {
  // Claude CLI로 실행
}
```

이 패턴을 미션 오케스트레이터에 확장 적용한다.

---

## 3. 오케스트레이터 설계

### 3.1 전체 흐름

```
사용자 입력: "내일 아침 10시에 실시간 뉴스를 분석해서 내게 줄 수 있어?"
                              ↓
┌──────────────────────────────────────────────────────┐
│                  1단계: 미션 분석                       │
│                                                      │
│  현재와 동일: Claude CLI로 라우팅 분석                    │
│  + 추가: 능력 요구사항 분류 (capability_tags)            │
│                                                      │
│  출력:                                                │
│  {                                                   │
│    routing: [...],                                   │
│    capability_tags: ["scheduling", "web_search"],     │
│    execution_plan: {                                 │
│      pre_tasks: [{ type: "openclaw_cron", ... }],    │
│      agent_tasks: [{ type: "c3", ... }],             │
│      post_tasks: [{ type: "openclaw_deliver", ... }] │
│    }                                                 │
│  }                                                   │
└──────────────────────────┬───────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────┐
│              2단계: 사전 보고서 생성                     │
│                                                      │
│  사용자에게 보여줄 디테일한 실행 계획:                     │
│  • 어떤 서브태스크가 있는지                               │
│  • 각 서브태스크를 왜 c3/OpenClaw로 배정했는지             │
│  • 필요한 리소스 (vault 시크릿, MCP 서버 등)              │
│  • 예상 실행 시간                                       │
│  • 리스크/제약사항                                       │
└──────────────────────────┬───────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────┐
│               3단계: 실행                              │
│                                                      │
│  execution_plan의 3종류 태스크를 순서대로 실행:            │
│                                                      │
│  pre_tasks:   인프라 설정 (크론 등록, 채널 준비)          │
│  agent_tasks: 에이전트별 작업 (c3 또는 OpenClaw)         │
│  post_tasks:  결과 전송 (채널 전송, 알림)                 │
└──────────────────────────────────────────────────────┘
```

### 3.2 능력 태그 (capability_tags) 정의

라우팅 분석 시 Claude가 태스크에 필요한 능력을 태그로 분류한다:

| 태그 | 의미 | 실행 수단 |
|------|------|-----------|
| `file_io` | 로컬 파일 읽기/쓰기/수정 | c3 |
| `code_execution` | 코드 실행, 빌드, 테스트 | c3 |
| `web_search` | 웹 검색, 정보 수집 | c3 또는 OpenClaw |
| `scheduling` | 예약 실행, 반복 실행 | OpenClaw `cron` |
| `channel_delivery` | Slack/Discord/Telegram 등 전송 | OpenClaw `channel` |
| `persistent_session` | 이전 대화 컨텍스트 필요 | OpenClaw `session` |
| `media_processing` | 이미지/음성/영상 처리 | OpenClaw `media` |
| `immediate` | 즉시 1회 실행 | c3 (기본) |

### 3.3 실행 수단 결정 로직

```
function resolveExecutor(tags: string[], gatewayAvailable: boolean): 'c3' | 'openclaw' | 'hybrid'

규칙:
1. scheduling || channel_delivery || persistent_session || media_processing
   → OpenClaw 필요 (gateway 필수)
   → gateway 미가용 시 → 폴백 전략 또는 에러

2. file_io || code_execution
   → c3 필요 (로컬 FS 접근)

3. 1 + 2 모두 해당
   → hybrid (pre/post = OpenClaw, agent = c3)

4. 태그 없음 또는 immediate만
   → c3 (기본값, 오버헤드 최소)
```

### 3.4 execution_plan 스키마

```typescript
interface ExecutionPlan {
  // 인프라 설정 (에이전트 실행 전)
  pre_tasks: PreTask[];

  // 에이전트별 작업 (현재 routing과 동일 + executor 지정)
  agent_tasks: AgentTask[];

  // 결과 처리 (에이전트 실행 후)
  post_tasks: PostTask[];
}

interface PreTask {
  type: 'openclaw_cron' | 'openclaw_session_init';
  params: Record<string, unknown>;
  // 예: { type: 'openclaw_cron', params: { name: '뉴스분석', cron: '0 1 * * *', tz: 'Asia/Seoul' } }
}

interface AgentTask {
  // 기존 routing 필드
  org_id: string;
  org_type: string;
  org_name: string;
  agent_id: string;
  agent_name: string;
  subtask: string;
  gate_type: 'auto' | 'human';

  // 신규 필드
  executor: 'c3' | 'openclaw';
  executor_reason: string;           // "로컬 파일 수정이 필요하여 c3 사용"
  capability_tags: string[];
  openclaw_params?: {                // executor === 'openclaw'일 때
    thinking?: string;
    model?: string;
    timeout_seconds?: number;
    session_key?: string;
  };
}

interface PostTask {
  type: 'openclaw_deliver' | 'notification' | 'schedule_register';
  params: Record<string, unknown>;
  // 예: { type: 'openclaw_deliver', params: { channel: 'slack', message: '...' } }
}
```

---

## 4. 구현 계획

### 4.1 Phase 1 — OpenClaw 실행 인터페이스 구축

**새 파일: `src/lib/openclaw-executor.ts`**

OpenClaw CLI/Gateway를 프로그래밍 방식으로 호출하는 통합 인터페이스.

```typescript
// 크론 잡 등록
async function openclawCronAdd(params: {
  name: string;
  cron?: string;         // "0 1 * * *"
  at?: string;           // "2026-04-12T01:00:00+09:00"
  every?: string;        // "10m"
  tz?: string;           // "Asia/Seoul"
  message: string;       // 에이전트에게 전달할 프롬프트
  agent?: string;        // 에이전트 ID
  thinking?: string;     // off|minimal|low|medium|high
  model?: string;
}): Promise<{ ok: boolean; jobId?: string; error?: string }>

// 에이전트 실행 (1회)
async function openclawAgentRun(params: {
  message: string;
  agent?: string;
  thinking?: string;
  model?: string;
  timeout?: number;
  sessionId?: string;
  deliver?: boolean;      // 채널 전송 여부
  channel?: string;       // slack, discord, telegram 등
  to?: string;            // 전송 대상
}): Promise<{ ok: boolean; output?: string; error?: string }>

// 크론 잡 목록 조회
async function openclawCronList(): Promise<CronJob[]>

// 크론 잡 삭제
async function openclawCronRemove(jobId: string): Promise<{ ok: boolean }>
```

**구현 방식 — 두 가지 경로:**

```
1순위: Gateway HTTP API (게이트웨이 가용 시)
  → POST /v1/chat/completions  (에이전트 실행)
  → WebSocket cron.add/list    (크론 관리)

2순위: CLI 직접 호출 (게이트웨이 불가 시)
  → execFile('openclaw', ['cron', 'add', ...])
  → execFile('openclaw', ['agent', '-m', ...])
```

Gateway HTTP 호출 시 필요한 헤더:

```
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer {OPENCLAW_GATEWAY_TOKEN}

{
  "model": "openclaw/{agentId}",
  "messages": [{ "role": "user", "content": "..." }],
  "stream": false
}
```

OpenClaw 크론 CLI 호출 시 인자:

```bash
openclaw cron add \
  --name "뉴스 분석" \
  --cron "0 1 * * *" \
  --tz "Asia/Seoul" \
  --message "실시간 뉴스를 수집하고 분석 리포트를 작성하세요" \
  --agent "agent-uuid" \
  --thinking medium \
  --json
```

### 4.2 Phase 2 — 라우팅 프롬프트 확장

**수정 파일: `src/app/api/missions/route.ts` — `buildRoutingPrompt()`**

현재 프롬프트에 OpenClaw 능력 정보를 추가한다:

```
현재:
  "routing 배열을 만들어라, gate_type을 판단해라"

변경 후:
  "routing 배열을 만들어라, gate_type을 판단해라
   + 각 서브태스크에 capability_tags를 부여해라
   + 전체 미션의 execution_plan을 설계해라
   + 스케줄/반복/채널전송이 필요하면 pre_tasks/post_tasks를 포함해라"
```

**프롬프트에 추가할 시스템 능력 설명:**

```markdown
## 실행 수단

이 시스템은 두 가지 실행 수단을 갖고 있습니다:

### c3 (Claude CLI) — 즉시 실행, 로컬 작업
- Read, Write, Edit, Bash 도구로 로컬 파일시스템 접근
- 코드 수정, 빌드, 테스트 실행 가능
- 게이트웨이 불필요, 독립 프로세스
- 스케줄링/외부 전송 불가

### OpenClaw — 스케줄링, 외부 전송, 세션
- 크론 스케줄링: 1회 예약(at), 반복(cron/every)
- 채널 전송: Slack, Discord, Telegram 등
- 영속 세션: 이전 대화 컨텍스트 유지
- 미디어 처리: 이미지, 음성, 영상

### 판단 기준
- 로컬 파일 작업 → executor: "c3"
- 예약/반복 실행 → pre_tasks에 openclaw_cron 추가
- 외부 전송 → post_tasks에 openclaw_deliver 추가
- 복합 → c3로 작업 + OpenClaw로 스케줄/전송
```

### 4.3 Phase 3 — 미션 실행 엔진 개조

**수정 파일: `src/app/api/missions/[id]/run/route.ts`**

현재 `callClaude()` 일변도에서 `execution_plan` 기반 3단계 실행으로 변경:

```
현재:
  for (routing) → callClaude(prompt, cwd)

변경 후:
  1. for (pre_tasks) → executePreTask(task)
     // openclaw_cron → openclawCronAdd(...)
     // openclaw_session_init → 세션 초기화

  2. for (agent_tasks) → executeAgentTask(task)
     // executor === 'c3' → callClaude(prompt, cwd)  [기존과 동일]
     // executor === 'openclaw' → openclawAgentRun(...)

  3. for (post_tasks) → executePostTask(task)
     // openclaw_deliver → 채널 전송
     // notification → 알림 생성
     // schedule_register → 로컬 DB 스케줄도 동기화
```

**동일 파일의 `mission-runner.ts` (백그라운드용)도 동일하게 수정.**

### 4.4 Phase 4 — 사전 보고서 UI

**수정 파일: `src/app/missions/page.tsx`**

라우팅 미리보기에 실행 계획 상세 표시:

```
┌─────────────────────────────────────────────┐
│ 📋 실행 계획                                 │
│                                             │
│ ⚙️ 사전 작업 (1건)                           │
│  └ OpenClaw 크론 등록: 매일 01:00 UTC        │
│    (KST 10:00) 뉴스 분석 실행                 │
│                                             │
│ 🤖 에이전트 작업 (1건)                        │
│  └ [유저 분석팀] 사업 운영실장                  │
│    executor: OpenClaw (세션 기반 웹 검색)      │
│    이유: "반복 실행 시 이전 분석 컨텍스트 활용"   │
│                                             │
│ 📤 후속 작업 (0건)                           │
│    (전송 채널 미설정)                          │
│                                             │
│ [취소]                    [▶ 미션 실행]       │
└─────────────────────────────────────────────┘
```

### 4.5 Phase 5 — 스케줄 연동

**현재**: `server.ts`의 `setInterval` 60초 폴링 → 로컬 DB `mission_schedules` → `runMissionBackground()`

**변경**: OpenClaw 크론과 양방향 동기화

```
미션에서 스케줄 생성 시:
  1. OpenClaw cron add (실제 실행 주체)
  2. 로컬 DB mission_schedules에도 저장 (UI 표시 + 백업)

OpenClaw 크론 실행 시:
  → OpenClaw agent가 작업 수행
  → 결과를 AI Hub에 콜백 (webhook 또는 폴링)
  → mission_jobs + missions 테이블 업데이트

로컬 스케줄러 (server.ts):
  → OpenClaw가 불가할 때의 폴백으로 유지
  → openclaw_cron_id가 없는 스케줄만 실행
```

---

## 5. 주의사항

### 5.1 게이트웨이 의존성 관리

OpenClaw 게이트웨이는 **항상 가용하다고 가정할 수 없다.** 현재 확인된 문제:

- `/health` 엔드포인트가 플러그인 오류(`@twurple/auth` 누락) 시 500 반환
- Control UI 빌드 실패 시 초기 시작이 ~3초 지연
- 게이트웨이 프로세스가 예상치 않게 종료될 수 있음

**필수 구현: 모든 OpenClaw 호출에 폴백 경로**

```typescript
async function executeWithFallback<T>(
  openclawFn: () => Promise<T>,
  fallbackFn: () => Promise<T>,
  context: string
): Promise<T> {
  if (await isGatewayAvailable()) {
    try {
      return await openclawFn();
    } catch (err) {
      console.warn(`[Orchestrator] OpenClaw 실패 (${context}), 폴백 실행:`, err);
      return fallbackFn();
    }
  }
  return fallbackFn();
}
```

**크론의 경우 폴백:**
- OpenClaw 크론 등록 실패 → 로컬 `mission_schedules` DB에 저장 + `server.ts` 폴링이 실행
- 사용자에게 "스케줄이 로컬 모드로 등록됨 (OpenClaw 가용 시 자동 전환)" 안내

### 5.2 데이터 일관성

OpenClaw 크론과 로컬 DB 스케줄이 이중으로 존재할 수 있다.

**원칙:**
- OpenClaw 크론이 **실행 주체** (source of truth)
- 로컬 DB는 **UI 표시 + 폴백용 복사본**
- `mission_schedules` 테이블에 `openclaw_cron_id` 컬럼 추가
- 스케줄 수정/삭제 시 OpenClaw 크론도 함께 수정/삭제

### 5.3 보안

- OpenClaw agent 실행 시 vault 시크릿을 어떻게 전달할지
  - c3: 환경변수로 직접 전달 (현재 방식, 안전)
  - OpenClaw: Gateway에 시크릿을 전달하면 메모리에 남을 수 있음
  - **방안**: OpenClaw agent 실행 시에도 `--tools` 제한 + vault 시크릿은 필요한 것만 선별 전달

- `--dangerously-skip-permissions` 플래그
  - c3에서 현재 사용 중 (미션 자동 실행을 위해)
  - OpenClaw에서는 `--tools exec,read,write` 로 허용 도구를 명시적으로 제한하는 것이 더 안전

### 5.4 세션 충돌

- c3와 OpenClaw가 같은 에이전트를 동시에 실행하면 세션 상태가 꼬일 수 있음
- **원칙**: 하나의 에이전트는 한 시점에 하나의 executor로만 실행
- 현재 `MissionJobs.queueForAgent(agentId)` 큐잉 로직이 이미 있으므로, executor 종류에 관계없이 동일한 큐를 사용

### 5.5 에러 메시지 사용자 경험

- "OpenClaw 게이트웨이에 연결할 수 없습니다" → 사용자에게 혼란
- **원칙**: 기술 용어 대신 행동 중심 메시지
  - ❌ "OpenClaw Gateway timeout"
  - ✅ "스케줄 등록에 실패했습니다. 로컬 모드로 전환하여 등록합니다."

### 5.6 기존 기능 하위 호환

- 현재 동작하는 모든 미션 (c3 기반)은 **그대로 동작해야 한다**
- OpenClaw 기능은 **추가(additive)** 이지 기존 교체가 아님
- `capability_tags`가 빈 배열이면 → 현재와 완전히 동일하게 c3 실행

---

## 6. 개발 순서 및 방법

### 6.1 단계별 구현 순서

```
Phase 1: OpenClaw 실행 인터페이스    (기반)
  ↓
Phase 2: 라우팅 프롬프트 확장        (두뇌)
  ↓
Phase 3: 미션 실행 엔진 개조         (핵심)
  ↓
Phase 4: 사전 보고서 UI              (UX)
  ↓
Phase 5: 스케줄 연동                 (통합)
```

**Phase 1이 가장 중요하고 독립적이다.** 나머지는 Phase 1 위에 점진적으로 쌓는다.

### 6.2 Phase 1 상세 — 파일별 작업

#### 신규: `src/lib/openclaw-executor.ts`

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isGatewayAvailable } from './openclaw-client';

const execFileAsync = promisify(execFile);

// OpenClaw 바이너리 경로 (gateway-manager.ts의 findOpenClawBinary 재사용)
function findBinary(): string | null { ... }

// ── 크론 관리 ──────────────────────────────────────────

export async function cronAdd(params: CronAddParams): Promise<CronResult> {
  // 1순위: Gateway WebSocket (가용 시)
  // 2순위: CLI 직접 호출
  const binary = findBinary();
  if (!binary) return { ok: false, error: 'openclaw_not_found' };

  const args = ['cron', 'add', '--name', params.name, '--json'];

  // 스케줄 타입
  if (params.cron) args.push('--cron', params.cron);
  else if (params.at) args.push('--at', params.at);
  else if (params.every) args.push('--every', params.every);

  if (params.tz) args.push('--tz', params.tz);
  if (params.message) args.push('--message', params.message);
  if (params.agent) args.push('--agent', params.agent);
  if (params.thinking) args.push('--thinking', params.thinking);
  if (params.model) args.push('--model', params.model);

  const { stdout } = await execFileAsync(binary, args, {
    encoding: 'utf8',
    timeout: 30_000,
  });

  return JSON.parse(stdout);
}

export async function cronList(): Promise<CronJob[]> { ... }
export async function cronRemove(jobId: string): Promise<{ ok: boolean }> { ... }

// ── 에이전트 실행 ──────────────────────────────────────

export async function agentRun(params: AgentRunParams): Promise<AgentResult> {
  // Gateway 가용 시: HTTP API
  if (await isGatewayAvailable()) {
    return agentRunViaGateway(params);
  }
  // 폴백: CLI
  return agentRunViaCli(params);
}

async function agentRunViaGateway(params: AgentRunParams): Promise<AgentResult> {
  const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
  const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

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

  const data = await res.json();
  return { ok: true, output: data.choices?.[0]?.message?.content ?? '' };
}

async function agentRunViaCli(params: AgentRunParams): Promise<AgentResult> {
  const binary = findBinary();
  if (!binary) return { ok: false, error: 'openclaw_not_found' };

  const args = ['agent', '-m', params.message, '--json'];
  if (params.agent) args.push('--agent', params.agent);
  if (params.thinking) args.push('--thinking', params.thinking);
  if (params.model) args.push('--model', params.model);
  if (params.timeout) args.push('--timeout', String(params.timeout));

  const { stdout } = await execFileAsync(binary, args, {
    encoding: 'utf8',
    timeout: (params.timeout ?? 300) * 1000 + 10_000,
  });

  return JSON.parse(stdout);
}
```

#### 수정: `src/lib/gateway-manager.ts`

`findOpenClawBinary()`를 export하여 `openclaw-executor.ts`에서 재사용:

```typescript
// 기존: function findOpenClawBinary(): string | null { ... }
// 변경:
export function findOpenClawBinary(): string | null { ... }
```

#### 신규: `src/lib/openclaw-executor.test.ts`

Phase 1 단독으로 테스트할 수 있는 유닛 테스트:

```typescript
// Gateway 미가용 시 CLI 폴백 테스트
// 크론 등록/조회/삭제 테스트
// 에이전트 실행 테스트
// 에러 핸들링 테스트
```

### 6.3 Phase 2 상세 — 프롬프트 변경

#### 수정: `src/app/api/missions/route.ts` — `buildRoutingPrompt()`

**추가할 JSON 스키마:**

```json
{
  "execution_plan": {
    "pre_tasks": [
      {
        "type": "openclaw_cron",
        "params": {
          "name": "뉴스 분석 스케줄",
          "cron": "0 1 * * *",
          "tz": "Asia/Seoul",
          "message": "실시간 뉴스를 수집하고 분석하세요"
        }
      }
    ],
    "post_tasks": []
  },
  "routing": [
    {
      "...기존 필드...",
      "executor": "c3",
      "executor_reason": "로컬 파일 작업이 필요하여 c3 사용",
      "capability_tags": ["file_io", "code_execution"]
    }
  ]
}
```

**프롬프트에 추가할 판단 가이드:**

```
executor 판단 기준:
- 기본값은 "c3" (로컬 Claude CLI 실행)
- 다음 경우 "openclaw" 사용:
  · 예약/반복 실행이 필요한 작업 → pre_tasks에 openclaw_cron도 추가
  · 외부 채널 전송이 필요한 작업
  · 이전 대화 맥락이 필요한 작업
- 로컬 파일 수정, 코드 작업은 반드시 "c3"
- 확실하지 않으면 "c3" (더 안전)
```

### 6.4 Phase 3 상세 — 실행 엔진

#### 수정: `src/app/api/missions/[id]/run/route.ts`

기존 `Promise.allSettled(routing.map(...))` 앞뒤에 pre/post 단계 추가:

```typescript
// ── 1단계: pre_tasks ──
if (executionPlan?.pre_tasks?.length) {
  for (const task of executionPlan.pre_tasks) {
    send({ type: 'pre_task', task_type: task.type, status: 'running' });
    try {
      await executePreTask(task, vaultEnv);
      send({ type: 'pre_task', task_type: task.type, status: 'done' });
    } catch (err) {
      send({ type: 'pre_task', task_type: task.type, status: 'failed', error: err.message });
      // pre_task 실패 시 전체 미션 중단하지 않음 (폴백 가능)
    }
  }
}

// ── 2단계: agent_tasks (기존 로직 확장) ──
await Promise.allSettled(agentTasks.map(async (task, idx) => {
  // ... 기존 큐 대기, gate 로직 ...

  if (task.executor === 'openclaw') {
    output = await openclawAgentRun({ message: buildPrompt(task), ... });
  } else {
    output = await callClaude(buildPrompt(task), wsPath, ...);  // 기존
  }
}));

// ── 3단계: post_tasks ──
if (executionPlan?.post_tasks?.length) {
  for (const task of executionPlan.post_tasks) {
    await executePostTask(task, results);
  }
}
```

### 6.5 DB 스키마 변경

#### `mission_schedules` 테이블

```sql
ALTER TABLE mission_schedules ADD COLUMN openclaw_cron_id TEXT;
-- OpenClaw 크론 잡 ID. NULL이면 로컬 스케줄러가 실행.
```

#### `missions` 테이블의 `steps` 필드

기존 `routingMeta` 객체에 `execution_plan` 추가:

```json
{
  "summary": "...",
  "execution_plan": { "pre_tasks": [...], "post_tasks": [...] },
  "routing": [{ "...기존...", "executor": "c3", "capability_tags": [...] }]
}
```

---

## 7. 테스트 시나리오

### 7.1 기본 동작 확인

| 시나리오 | 기대 결과 |
|---------|-----------|
| "이 코드 리팩토링해줘" | executor: c3, pre/post_tasks 없음 |
| "내일 아침 10시에 뉴스 분석" | pre_tasks: openclaw_cron, executor: openclaw |
| "이 파일 수정하고 슬랙에 알려줘" | executor: c3, post_tasks: openclaw_deliver |
| "매주 월요일 보고서 작성" | pre_tasks: openclaw_cron, executor: c3 또는 openclaw |

### 7.2 폴백 시나리오

| 시나리오 | 기대 결과 |
|---------|-----------|
| OpenClaw 미실행 + "코드 리팩토링" | c3 정상 실행 (영향 없음) |
| OpenClaw 미실행 + "내일 10시 뉴스" | 크론 등록 실패 → 로컬 스케줄 등록 + 안내 메시지 |
| OpenClaw 실행 중 + 게이트웨이 크래시 | 진행 중 잡 → c3 폴백, 미완료 크론 → 로컬 폴백 |

### 7.3 하위 호환

| 시나리오 | 기대 결과 |
|---------|-----------|
| 기존 미션 재실행 (execution_plan 없음) | 현재와 동일하게 c3 실행 |
| 기존 스케줄 실행 (openclaw_cron_id 없음) | server.ts 폴링이 기존대로 실행 |

---

## 8. 파일 변경 요약

| 파일 | 변경 | Phase |
|------|------|-------|
| `src/lib/openclaw-executor.ts` | **신규** — OpenClaw CLI/Gateway 통합 인터페이스 | 1 |
| `src/lib/gateway-manager.ts` | `findOpenClawBinary` export | 1 |
| `src/app/api/missions/route.ts` | `buildRoutingPrompt()` 확장 | 2 |
| `src/app/api/missions/[id]/run/route.ts` | 3단계 실행 엔진 | 3 |
| `src/lib/mission-runner.ts` | 백그라운드 실행도 동일하게 | 3 |
| `src/app/missions/page.tsx` | 사전 보고서 UI | 4 |
| `src/lib/db.ts` | `mission_schedules` 컬럼 추가 | 5 |
| `server.ts` | 폴백 스케줄러 로직 수정 | 5 |

---

## 9. 성공 기준

1. "내일 아침 10시에 뉴스 분석해줘" → OpenClaw 크론 등록 + 에이전트 실행 자동 완료
2. "이 코드 리팩토링해줘" → 기존과 동일하게 c3로 즉시 실행
3. OpenClaw 게이트웨이 꺼진 상태에서도 모든 미션이 (폴백으로) 실행 가능
4. 사용자가 c3/OpenClaw 구분을 인지하지 않아도 됨
