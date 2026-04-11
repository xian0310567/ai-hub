# 향후 작업 (Next Steps)

현재 코드 상태를 기반으로 정리한 다음 단계 구현 계획.

---

## A. 채널별 라우팅 커스터마이징

### 현재 상태

모든 채널(web, telegram, discord, slack)이 `orchestrator` 에이전트로 고정 라우팅된다.

**`packages/vm-server/src/services/openclaw-sync.ts:291-305`**

```typescript
const bindings: OpenClawBinding[] = [
  { agentId: orchestratorId, match: { channel: 'web' } },
];

for (const ch of channels) {
  bindings.push({ agentId: orchestratorId, match: { channel: ch.channel_type } });
}
```

`openclaw_channels` 테이블에는 라우팅 대상 컬럼이 없다.

**`packages/vm-server/src/db/schema.ts:266-274`** — 현재 스키마:

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | TEXT PK | 채널 고유 ID |
| org_id | TEXT FK | 조직 참조 |
| channel_type | TEXT | telegram, discord, slack, web |
| config | TEXT (JSON) | 채널별 설정 |
| enabled | BOOLEAN | 활성화 여부 |
| created_at | BIGINT | 생성 시각 |

### 구현 계획

#### 1. DB 스키마 변경

`openclaw_channels` 테이블에 `target_agent_id` 컬럼 추가:

```sql
ALTER TABLE openclaw_channels
  ADD COLUMN target_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
```

- `NULL`이면 기존 동작 유지(orchestrator로 라우팅)
- 값이 있으면 해당 에이전트(또는 팀 리더)로 직접 라우팅

#### 2. Sync 서비스 바인딩 생성 분기

**`packages/vm-server/src/services/openclaw-sync.ts`** — `generateOpenClawConfig()` 내부 수정:

```typescript
for (const ch of channels) {
  const cfg = JSON.parse(ch.config);
  channelConfig[ch.channel_type] = cfg;

  // target_agent_id가 있으면 해당 에이전트로 직접 라우팅
  const targetId = ch.target_agent_id
    ? toAgentId(/* 해당 에이전트 name 조회 */)
    : orchestratorId;

  bindings.push({ agentId: targetId, match: { channel: ch.channel_type } });
}
```

- `target_agent_id`로 지정된 에이전트가 config의 agents.list에 존재하는지 검증 필요
- 존재하지 않는 에이전트 지정 시 경고 로그 + orchestrator 폴백

#### 3. API 변경

**`packages/vm-server/src/routes/openclaw-channels.ts`**:

- `POST /api/openclaw/channels` — payload에 `target_agent_id` 선택 필드 추가
- `PATCH /api/openclaw/channels` — `target_agent_id` 업데이트 지원
- `GET /api/openclaw/channels` — 응답에 `target_agent_id` 포함 + 해당 에이전트 이름 JOIN

#### 4. UI 변경

채널 설정 화면에서 "라우팅 대상" 드롭다운 추가:
- 기본값: "오케스트레이터 (자동 분배)"
- 옵션: 조직 내 에이전트/팀 리더 목록

---

## B. Gateway 자동 시작 연동

### 현재 상태

Gateway는 수동 시작만 지원. 사용자가 UI에서 "Gateway 시작" 버튼을 눌러야 한다.

**`packages/electron-app/src/lib/gateway-manager.ts`**:
- `startGateway(manual?)` — 게이트웨이 프로세스 생성
- `stopGateway()` — SIGTERM으로 종료
- `getGatewayInfo()` — 상태 조회 (state, pid, restartCount, available, port)
- 헬스체크 15초 간격, 자동 재시작 최대 5회 (exponential backoff: 2000ms × restartCount)

**호출처**: `packages/electron-app/src/app/api/openclaw/gateway/route.ts`의 POST endpoint뿐.
UI에서 `OpenClawStatus.tsx` 컴포넌트가 이 API를 호출한다.

**부팅 시퀀스** (`packages/electron-app/server.ts`):
1. 실패한 missions/jobs 정리
2. Mission scheduler 시작
3. HTTP + Socket.IO 서버 시작
4. **Gateway 초기화 없음**

`instrumentation.ts` 파일은 존재하지 않는다.

### 구현 계획

#### 1. 자동 시작 설정 플래그

**`packages/electron-app/src/lib/db.ts`** — settings 테이블 활용:

```typescript
// 키: 'gateway_auto_start', 값: 'true' | 'false'
Settings.get('gateway_auto_start')  // default: 'false'
```

#### 2. server.ts에서 조건부 초기화

**`packages/electron-app/server.ts`** — HTTP 서버 시작 직후:

```typescript
httpServer.listen(port, '0.0.0.0', async () => {
  console.log(`> Ready on http://0.0.0.0:${port}`);

  // Gateway 자동 시작
  const autoStart = Settings.get('gateway_auto_start');
  if (autoStart === 'true') {
    const { startGateway } = await import('./lib/gateway-manager');
    startGateway().catch((err) =>
      console.error('[Gateway AutoStart] 실패:', err)
    );
  }
});
```

- `server.ts`는 현재 mission scheduler를 시작하는 패턴이 이미 있으므로 동일한 위치에 추가
- `instrumentation.ts` 신규 생성보다 기존 서버 부팅 흐름에 추가하는 것이 일관성 있음

#### 3. UI 설정 토글

**`packages/electron-app/src/components/OpenClawStatus.tsx`**:

Gateway 상태 패널에 "앱 시작 시 자동 실행" 토글 스위치 추가:
- `/api/settings` 엔드포인트로 `gateway_auto_start` 값 저장
- 토글 변경 시 즉시 DB에 반영

#### 4. Electron 연동

**`packages/electron-app/electron/main.js`** — `app.whenReady()` 시퀀스:

현재:
```javascript
await startNextServer();
await waitForNext();
createTray();
createWindow();
daemon.start();
```

Next.js 서버가 `server.ts`에서 자체적으로 Gateway를 시작하므로 Electron 측 추가 작업 불필요.
단, Next.js 서버 준비 완료 후 Gateway 시작이 보장되어야 하므로 `waitForNext()` 이후 시점에서 동작.

---

## C. 세션 히스토리 검색/필터

### 현재 상태

**Electron App 측** (`packages/electron-app/src/components/SessionHistory.tsx`):
- 시간순 목록만 제공 (최신 먼저)
- `agent_id`, `session_key`, `last_at`, `msg_count`로 세션 그룹화
- 검색/필터 UI 없음

**Electron App DB 쿼리** (`packages/electron-app/src/lib/db.ts:162-168`):

```sql
SELECT agent_id, session_key, MAX(created_at) as last_at, COUNT(*) as msg_count
FROM chat_logs WHERE user_id = ?
GROUP BY agent_id, session_key
ORDER BY last_at DESC LIMIT ?
```

**OpenClaw Gateway 측** (`packages/openclaw/src/gateway/session-utils.ts:1409-1516`):
- `listSessionsFromStore()` — 이미 구현된 필터:
  - `search`: displayName, label, subject, sessionId, key에 대한 substring 검색
  - `agentId`: 에이전트별 필터
  - `activeMinutes`: 시간 범위 필터
  - `label`: 라벨 필터
  - `spawnedBy`: 부모 세션 필터
- 테스트: `session-utils.search.test.ts`에 검색 테스트 존재

**API 엔드포인트** (`packages/electron-app/src/app/api/sessions/route.ts`):
- `?agent_id=<id>` — 에이전트 필터 (이미 존재)
- `?session_key=<key>` — 특정 세션 메시지 로드 (이미 존재)
- `?source=local|gateway` — 데이터 소스 선택 (이미 존재)

### 구현 계획

#### 1. 에이전트별 필터

**현재**: API에 `agent_id` 파라미터 이미 존재하지만 UI에서 사용하지 않음.

**SessionHistory.tsx** 수정:
- 세션 목록 상단에 에이전트 필터 드롭다운 추가
- `GET /api/sessions?agent_id=xxx`로 필터링된 목록 요청
- "전체" 옵션으로 필터 해제

#### 2. 텍스트 검색

**DB 레벨** — `packages/electron-app/src/lib/db.ts`에 검색 쿼리 추가:

```typescript
ChatLogs.search(userId: string, query: string, limit = 50) {
  return db.prepare(`
    SELECT cl.*, 
           snippet(chat_logs_fts, 0, '<mark>', '</mark>', '...', 32) as highlight
    FROM chat_logs_fts
    JOIN chat_logs cl ON cl.rowid = chat_logs_fts.rowid
    WHERE chat_logs_fts MATCH ? AND cl.user_id = ?
    ORDER BY rank LIMIT ?
  `).all(query, userId, limit);
}
```

SQLite FTS5 가상 테이블 생성 (마이그레이션):

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS chat_logs_fts
USING fts5(content, content=chat_logs, content_rowid=rowid);

-- 기존 데이터 인덱싱
INSERT INTO chat_logs_fts(rowid, content) SELECT rowid, content FROM chat_logs;
```

- FTS5를 사용하면 `LIKE '%query%'`보다 대량 데이터에서 성능이 우수
- 트리거로 chat_logs INSERT/UPDATE/DELETE 시 FTS 인덱스 자동 동기화

**API** — `GET /api/sessions?q=검색어` 파라미터 추가

**UI** — SessionHistory.tsx 상단에 검색 입력 필드 추가:
- 디바운스 300ms 적용
- 검색 결과에서 매칭된 메시지 하이라이트

#### 3. 날짜 범위 필터

**DB 쿼리 확장**:

```sql
SELECT agent_id, session_key, MAX(created_at) as last_at, COUNT(*) as msg_count
FROM chat_logs
WHERE user_id = ?
  AND created_at >= ?  -- from (epoch seconds)
  AND created_at <= ?  -- to (epoch seconds)
GROUP BY agent_id, session_key
ORDER BY last_at DESC LIMIT ?
```

**API** — `GET /api/sessions?from=1712000000&to=1712100000`

**UI**:
- "오늘", "최근 7일", "최근 30일" 프리셋 버튼
- 커스텀 날짜 범위 선택 (date picker)

#### 4. 세션 삭제

**API** — `DELETE /api/sessions?agent_id=xxx&session_key=yyy`

```typescript
ChatLogs.deleteSession(userId: string, agentId: string, sessionKey: string) {
  return db.prepare(
    'DELETE FROM chat_logs WHERE user_id = ? AND agent_id = ? AND session_key = ?'
  ).run(userId, agentId, sessionKey);
}
```

**UI**: 세션 항목에 삭제 버튼 (확인 다이얼로그 포함)

#### 5. 세션 내보내기

**API** — `GET /api/sessions/export?agent_id=xxx&session_key=yyy&format=json|md`

- JSON: `{ session: { agentId, sessionKey, messages: [...] } }`
- Markdown: 대화 형식으로 포맷팅

**UI**: 세션 상세 뷰에 "내보내기" 버튼 → 파일 다운로드

---

## D. OpenClaw config diff & 선택적 sync

### 현재 상태

Sync는 전체 재생성 방식. 매 호출 시 런타임 디렉토리를 삭제하고 처음부터 다시 만든다.

**`packages/vm-server/src/services/openclaw-sync.ts:340-491`** — `materializeOpenClawWorkspace()`:

1. 동시성 제어 (org별 락)
2. `generateOpenClawConfig()` 호출 → 전체 config 생성
3. 런타임 디렉토리 삭제 + 재생성 (`{DATA_DIR}/openclaw-runtime/{orgId}/`)
4. `openclaw.json` 작성
5. 에이전트별 workspace 디렉토리 + `SOUL.md` + `.claude/agents/*.md` 파일 생성
6. DB `openclaw_configs` 테이블에 config JSON + version 저장

**디렉토리 구조**:
```
{DATA_DIR}/openclaw-runtime/{orgId}/
├── openclaw.json
├── orchestrator/
│   ├── SOUL.md
│   └── .claude/agents/{agent-id}.md ...
├── {team-id}/
│   ├── SOUL.md
│   └── .claude/agents/{agent-id}.md ...
└── {standalone-agent-id}/
    └── SOUL.md
```

**저장된 config 조회**: `GET /api/openclaw/stored` — `openclaw_configs` 테이블에서 읽기

현재 diff/비교 로직은 전혀 없다.

### 구현 계획

#### 1. Config Diff 엔진

**신규 함수**: `diffOpenClawConfig(stored, generated)` in `openclaw-sync.ts`

```typescript
interface ConfigDiff {
  agents: {
    added: OpenClawAgentEntry[];
    removed: OpenClawAgentEntry[];
    modified: Array<{
      agentId: string;
      changes: {
        field: string;   // 'soul', 'model', 'allowAgents', ...
        old: string;
        new: string;
      }[];
    }>;
    unchanged: string[];  // agent IDs
  };
  bindings: {
    added: OpenClawBinding[];
    removed: OpenClawBinding[];
  };
  channels: {
    added: string[];
    removed: string[];
    modified: string[];
  };
}
```

비교 기준:
- 에이전트: `id`를 키로 매칭, `soul`, `model`, `allowAgents`, `commandName` 비교
- 바인딩: `channel` + `agentId` 조합으로 매칭
- 채널: `channel_type`으로 매칭, config JSON deep-equal

#### 2. 선택적 파일 재기록

**`materializeOpenClawWorkspace()` 수정**:

```typescript
// 기존: 전체 삭제 + 재생성
// 변경: diff 기반 선택적 업데이트

const stored = await getStoredConfig(orgId);
const generated = await generateOpenClawConfig(orgId);
const diff = diffOpenClawConfig(stored?.config, generated);

if (diff.agents.added.length > 0) {
  // 새 에이전트 디렉토리 + 파일 생성
}

for (const mod of diff.agents.modified) {
  // 변경된 에이전트의 SOUL.md, agent.md만 재작성
}

for (const removed of diff.agents.removed) {
  // 삭제된 에이전트 디렉토리 제거
}

// openclaw.json은 항상 재작성 (bindings, channels 반영)
```

#### 3. Diff Preview API

**`GET /api/openclaw/diff`** — 저장된 config와 현재 DB 상태의 차이 반환

```typescript
// openclaw.ts route 추가
app.get('/api/openclaw/diff', async (req, res) => {
  const stored = await getStoredConfig(orgId);
  const generated = await generateOpenClawConfig(orgId);
  const diff = diffOpenClawConfig(stored?.config, generated);
  return { ok: true, diff, hasChanges: !isDiffEmpty(diff) };
});
```

#### 4. UI Diff 프리뷰

Sync 버튼 클릭 시 바로 실행하는 대신:

1. `/api/openclaw/diff` 호출
2. 변경 사항 모달 표시:
   - 추가된 에이전트 (초록)
   - 수정된 에이전트 (노랑) — 변경된 필드 표시
   - 삭제된 에이전트 (빨강)
   - 바인딩/채널 변경
3. "적용" 버튼으로 선택적 sync 실행
4. 변경 없으면 "변경 사항 없음" 표시

---

## E. 실시간 Gateway 로그 스트리밍

### 현재 상태

Gateway 프로세스의 stdout/stderr는 pipe 설정되어 있지만 아무도 읽지 않는다.

**`packages/electron-app/src/lib/gateway-manager.ts:105`**:

```typescript
_process = spawn(binary, args, {
  stdio: ['ignore', 'pipe', 'pipe'],  // stdout, stderr 파이프됨
  detached: false,
  env: { ... }
});

// stdout/stderr 리스너 없음 — 로그 유실
_process.on('exit', ...);   // 종료 핸들링만 존재
_process.on('error', ...);  // 에러 핸들링만 존재
```

**Socket.IO** (`packages/electron-app/server.ts:149-157`):

```typescript
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*' },
  path: '/socket.io',
});

io.on('connection', (socket) => {
  // 연결/해제 로그만 — 이벤트 핸들러 없음
});
```

Socket.IO 인프라는 준비되어 있으나 로그 스트리밍에 사용되지 않는다.

### 구현 계획

#### 1. Gateway 로그 캡처

**`packages/electron-app/src/lib/gateway-manager.ts`** 수정:

```typescript
import { EventEmitter } from 'events';

export const gatewayLogs = new EventEmitter();

// 링 버퍼: 최근 로그 유지 (신규 클라이언트 접속 시 히스토리 전송용)
const LOG_BUFFER_SIZE = 500;
const logBuffer: GatewayLogEntry[] = [];

interface GatewayLogEntry {
  ts: number;       // epoch ms
  stream: 'stdout' | 'stderr';
  line: string;
}

// startGateway() 내부, _process 생성 후:
_process.stdout?.on('data', (chunk: Buffer) => {
  const lines = chunk.toString().split('\n').filter(Boolean);
  for (const line of lines) {
    const entry: GatewayLogEntry = { ts: Date.now(), stream: 'stdout', line };
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
    gatewayLogs.emit('log', entry);
  }
});

_process.stderr?.on('data', (chunk: Buffer) => {
  const lines = chunk.toString().split('\n').filter(Boolean);
  for (const line of lines) {
    const entry: GatewayLogEntry = { ts: Date.now(), stream: 'stderr', line };
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
    gatewayLogs.emit('log', entry);
  }
});

export function getLogBuffer(): GatewayLogEntry[] {
  return [...logBuffer];
}
```

#### 2. Socket.IO 이벤트 연결

**`packages/electron-app/server.ts`** 수정:

```typescript
import { gatewayLogs, getLogBuffer } from './lib/gateway-manager';

io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  // gateway:logs 룸 구독
  socket.on('gateway:subscribe', () => {
    socket.join('gateway:logs');
    // 기존 버퍼 전송 (히스토리)
    socket.emit('gateway:history', getLogBuffer());
  });

  socket.on('gateway:unsubscribe', () => {
    socket.leave('gateway:logs');
  });

  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected:', socket.id);
  });
});

// EventEmitter → Socket.IO 브릿지
gatewayLogs.on('log', (entry) => {
  io.to('gateway:logs').emit('gateway:log', entry);
});
```

#### 3. 프론트엔드 로그 뷰어

**신규 컴포넌트**: `GatewayLogViewer.tsx`

기능:
- Socket.IO 클라이언트로 `gateway:logs` 룸 구독
- 터미널 스타일 로그 출력 (모노스페이스, 다크 배경)
- stdout은 흰색, stderr는 빨간색으로 구분
- 자동 스크롤 (하단 고정, 수동 스크롤 시 일시 정지)
- 로그 레벨 필터 (stdout/stderr 토글)
- 검색 기능 (Ctrl+F 스타일 인라인 검색)
- 로그 다운로드 (텍스트 파일)

#### 4. UI 배치

**`packages/electron-app/src/components/OpenClawStatus.tsx`**:

Gateway 상태 패널 하단에 "로그 보기" 토글 추가:
- 접기/펼치기로 로그 뷰어 표시
- Gateway 중지 상태에서는 "Gateway를 시작하면 로그가 표시됩니다" 안내

#### 5. 디버깅 활용

실시간 로그에서 확인 가능한 정보:
- 에이전트 간 `sessions_send` 메시지 흐름
- 채널 바인딩 매칭 과정
- 세션 생성/종료 이벤트
- 에러 및 스택 트레이스
- 헬스체크 응답 상태
