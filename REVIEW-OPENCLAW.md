# OpenClaw 통합 코드 리뷰 & 수정 계획

> 작성일: 2026-04-10
> 브랜치: `claude/review-integration-design-Io57x`
> 범위: 작업 1~5 (Gateway 연동, UI 분기, 채널 관리, 상태 위젯, 세션 히스토리)

---

## P0 — 즉시 수정 (보안 / 데이터 유실)

### 1. [보안] PATCH /api/openclaw/channels 응답에서 org_id 검증 누락

**파일**: `packages/vm-server/src/routes/openclaw-channels.ts:103`

```typescript
// 현재: org_id 검증 없이 반환 — 다른 조직 데이터 노출 가능
return q1('SELECT * FROM openclaw_channels WHERE id = ?', [id]);
```

**수정**:
```typescript
return q1('SELECT * FROM openclaw_channels WHERE id = ? AND org_id = ?', [id, user.orgId]);
```

**이유**: 앞에서 existing 검증(line 92)은 하지만, 최종 SELECT에는 빠져 있음. id가 UUID라 추측 공격 확률은 낮지만, 멀티 테넌트 시스템에서 반드시 막아야 하는 패턴.

---

### 2. [동시성] materializeOpenClawWorkspace 동시 호출 시 race condition

**파일**: `packages/vm-server/src/services/openclaw-sync.ts:332-333`

```typescript
fs.rmSync(runtimeDir, { recursive: true, force: true });  // 1) 삭제
fs.mkdirSync(runtimeDir, { recursive: true });             // 2) 재생성
// 1과 2 사이에 다른 sync가 끼어들면 파일 소실
```

**수정 방안**: org별 sync lock 추가

```typescript
// openclaw-sync.ts 상단에 추가
const syncLocks = new Map<string, Promise<void>>();

export async function materializeOpenClawWorkspace(orgId: string) {
  // 이전 sync가 끝날 때까지 대기
  while (syncLocks.has(orgId)) {
    await syncLocks.get(orgId);
  }

  let resolve: () => void;
  syncLocks.set(orgId, new Promise(r => { resolve = r; }));

  try {
    // ... 기존 로직
  } finally {
    syncLocks.delete(orgId);
    resolve!();
  }
}
```

**이유**: 하네스 생성 시 `/api/harness/route.ts`에서 sync를 fire-and-forget으로 호출함. 여러 팀을 빠르게 생성하면 동시 호출 발생.

---

### 3. [데이터 유실] stream.tee() 로그 저장 실패가 무음 처리됨

**파일 2곳**:
- `packages/electron-app/src/app/api/chat/[agentId]/route.ts:190-203`
- `packages/electron-app/src/app/api/openclaw/chat/[agentId]/route.ts:121-141`

```typescript
// 현재: catch {} — 모든 에러 무시
(async () => {
  // ...
  try {
    // stream 읽기 + ChatLogs.add()
  } catch {}  // ← DB 에러, 스트림 에러 전부 삼킴
})();
```

**수정** (두 파일 모두):
```typescript
(async () => {
  const reader = logStream.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fullText += decoder.decode(value, { stream: true });
    }
    if (fullText.trim()) {
      ChatLogs.add({
        id: randomUUID(),
        user_id: userId,
        agent_id: agentId,
        role: 'assistant',
        content: fullText.trim(),
        session_key: key,
      });
    }
  } catch (err) {
    console.error(`[ChatLog] 대화 기록 저장 실패 (agent=${agentId}):`, err);
  } finally {
    reader.releaseLock();
  }
})();
```

**이유**: 대화 기록이 누락되면 세션 히스토리가 불완전해지고, 디버깅도 불가. 최소한 로그는 남겨야 함.

---

## P1 — 이번 주 수정 (기능 정합성)

### 4. [로직] 세션 메시지 merge가 local/gateway 중 하나만 선택

**파일**: `packages/electron-app/src/app/api/sessions/route.ts:45-52`

```typescript
// 현재: local이 1개라도 있으면 gateway 전부 무시
messages: localMessages.length > 0 ? localMessages : gatewayMessages.map(...)
```

**수정**:
```typescript
// local 우선, 없으면 gateway fallback. 향후 merge 필요 시 확장.
const messages = localMessages.length > 0
  ? localMessages
  : gatewayMessages.map((m, i) => ({
      id: `gw-${i}`,
      user_id: user.id,
      agent_id: agentId,
      role: m.role,
      content: m.content,
      session_key: sessionKey,
      created_at: Math.floor(Date.now() / 1000) - (gatewayMessages.length - i),
    }));
```

**추가**: gateway fallback 메시지에 `created_at` 근사값 부여 (현재 누락 → 프론트 타임스탬프 미표시).

---

### 5. [UX] SessionHistory 세션 전환 시 이전 메시지 잔류

**파일**: `packages/electron-app/src/components/SessionHistory.tsx:128-135`

```typescript
const loadMessages = useCallback(async (agentId: string, sessionKey: string) => {
  setLoading(true);
  setSelected({ agentId, sessionKey });
  // ← setMessages([]) 누락! fetch 실패 시 이전 메시지가 남음
  try {
```

**수정**:
```typescript
const loadMessages = useCallback(async (agentId: string, sessionKey: string) => {
  setLoading(true);
  setSelected({ agentId, sessionKey });
  setMessages([]);  // 이전 메시지 즉시 클리어
  try {
```

---

### 6. [동시성] Gateway 프로세스 이중 spawn

**파일**: `packages/electron-app/src/lib/gateway-manager.ts:102-110, 182-194`

**시나리오**: 프로세스 crash → exit 이벤트에서 `setTimeout(() => startGateway())` + health check에서도 `startGateway()` → 동시 2개 spawn

**수정**:
```typescript
export async function startGateway(): Promise<{ ok: boolean; reason?: string }> {
  // 이미 starting 중이면 중복 방지
  if (_state === 'starting') {
    return { ok: false, reason: 'already_starting' };
  }

  if (await isGatewayAvailable()) {
    _state = 'running';
    startHealthCheck();
    return { ok: true, reason: 'already_running' };
  }

  // ... 나머지 기존 로직
}
```

health check에서도 backoff 적용:
```typescript
// 현재 (line 191)
if (_restartCount < MAX_RESTARTS) {
  _restartCount++;
  startGateway();  // ← backoff 없음
}

// 수정
if (_restartCount < MAX_RESTARTS) {
  _restartCount++;
  setTimeout(() => startGateway(), 2000 * _restartCount);
}
```

---

### 7. [무음 에러] 채널 config JSON 파싱 실패 시 binding만 생성되고 config은 빠짐

**파일**: `packages/vm-server/src/services/openclaw-sync.ts:285-292`

```typescript
for (const ch of channels) {
  try {
    const cfg = JSON.parse(ch.config);
    channelConfig[ch.channel_type] = cfg;
    bindings.push({ agentId: orchestratorId, match: { channel: ch.channel_type } });
  } catch {}  // ← JSON 파싱 실패하면 binding도 안 추가되어야 하는데, 현재는 그냥 무시
}
```

**수정**:
```typescript
for (const ch of channels) {
  try {
    const cfg = JSON.parse(ch.config);
    channelConfig[ch.channel_type] = cfg;
    bindings.push({ agentId: orchestratorId, match: { channel: ch.channel_type } });
  } catch (err) {
    console.warn(`[OpenClaw Sync] 채널 ${ch.channel_type} config 파싱 실패, 건너뜀:`, err);
    // binding 추가 안 함 — config 없는 binding은 무의미
  }
}
```

---

### 8. [데이터 불일치] 채널 DELETE 후 stored config에 삭제된 채널 잔존

**파일**: `packages/vm-server/src/routes/openclaw-channels.ts:110-117`

채널을 삭제해도 `openclaw_configs` 테이블의 JSON에는 그 채널이 남아있음. 다음 sync까지 불일치.

**수정**: DELETE 후 해당 org의 config version을 bump하여 "재sync 필요" 시그널:

```typescript
app.delete('/', async (req, reply) => {
  const user = await requireAuth(req, reply);
  if (!requireRole(user, ['org_admin'], reply)) return;

  const { id } = req.body as { id: string };
  await exec('DELETE FROM openclaw_channels WHERE id = ? AND org_id = ?', [id, user.orgId]);

  // stored config 무효화 (다음 조회 시 재생성 유도)
  await exec('DELETE FROM openclaw_configs WHERE org_id = ?', [user.orgId]);

  return { ok: true };
});
```

---

## P2 — 다음 스프린트 (안정성)

### 9. [스트림] openclaw-client.ts timeout과 controller.close() 경합

**파일**: `packages/electron-app/src/lib/openclaw-client.ts:77-83`

timeout 콜백에서 `controller.enqueue()` + `controller.close()` 호출 시, 메인 루프의 `controller.close()` (line 168)와 경합하여 "controller already closed" 에러 발생 가능.

**수정**: closed 플래그 도입:
```typescript
return new ReadableStream({
  async start(controller) {
    let closed = false;
    const safeClose = () => { if (!closed) { closed = true; controller.close(); } };
    const safeEnqueue = (chunk: Uint8Array) => { if (!closed) controller.enqueue(chunk); };
    // ... safeClose/safeEnqueue 사용
  },
});
```

---

### 10. [스트림] reader 미해제

**파일**: `packages/electron-app/src/lib/openclaw-client.ts:133`

에러 발생 시 `res.body.getReader()`로 얻은 reader를 `cancel()`하지 않음 → 연결 미해제.

**수정**: finally 블록에서 reader release:
```typescript
} finally {
  try { reader?.releaseLock(); } catch {}
  clearTimeout(timeout);
}
```

---

### 11. [fallback] Gateway 체크 후 요청 사이에 Gateway 죽으면 fallback 없음

**파일**: `packages/electron-app/src/app/api/chat/[agentId]/route.ts:161-165`

```typescript
const gatewayAvailable = await isGatewayAvailable();  // true
// ← 이 사이에 Gateway 프로세스 crash
if (gatewayAvailable) {
  return respondViaGateway(...);  // Gateway 죽은 상태에서 에러 스트림 반환
}
```

현재 사용자에게는 Gateway 에러 메시지가 표시되고, CLI fallback이 시도되지 않음.

**수정 방안** (간단): `sendToGateway()` 스트림 첫 응답이 에러이면 CLI로 재시도하는 래퍼. 단, 구현 복잡도가 높아 P2로 분류.

---

### 12. [동시성] Gateway manager의 MAX_RESTARTS 도달 후 복구 불가

**파일**: `packages/electron-app/src/lib/gateway-manager.ts:65`

`_restartCount`가 5에 도달하면 더 이상 자동 재시작 안 함. 수동으로 `startGateway()` 호출해도 카운터가 리셋되지 않음 (line 121에서 성공 시에만 리셋).

**수정**: `startGateway()` 진입 시 수동 호출은 카운터 리셋:
```typescript
export async function startGateway(manual = false): Promise<...> {
  if (manual) _restartCount = 0;
  // ...
}
```

프론트 `/api/openclaw/gateway` POST에서 `startGateway(true)` 호출.

---

### 13. [agentId 충돌] toAgentId() 결과 중복 가능

**파일**: `packages/vm-server/src/services/openclaw-sync.ts:103-110`

"Dev-Team"과 "Dev Team" 모두 `dev-team`으로 변환됨. OpenClaw config에서 같은 id의 에이전트 2개가 등록되어 후자가 전자를 덮어씀.

**수정**: agentList 생성 시 collision 감지:
```typescript
const usedIds = new Set<string>();
function uniqueAgentId(commandName: string | null, name: string): string {
  let id = toAgentId(commandName, name);
  let suffix = 2;
  while (usedIds.has(id)) { id = `${toAgentId(commandName, name)}-${suffix++}`; }
  usedIds.add(id);
  return id;
}
```

---

### 14. [성능] chat_logs 테이블 인덱스 없음

**파일**: `packages/electron-app/src/lib/db.ts`

sessions() 쿼리가 `GROUP BY agent_id, session_key`를 사용하는데 인덱스가 없어 full scan.

**수정**: 스키마에 인덱스 추가:
```sql
CREATE INDEX IF NOT EXISTS idx_chat_logs_user_session
  ON chat_logs(user_id, agent_id, session_key);
```

---

### 15. [메모리] OpenClawStatus 이벤트 리스너 누수

**파일**: `packages/electron-app/src/components/OpenClawStatus.tsx:145-152`

`open` 상태에서 `document.addEventListener('mousedown', handler)` 추가. unmount 시 `open=true`이면 cleanup이 실행되지만, effect deps에 `[open]`만 있어서 `open`이 바뀌지 않고 unmount되면 리스너가 잔존.

**수정**: cleanup을 항상 반환:
```typescript
useEffect(() => {
  if (!open) return;
  const handler = (e: MouseEvent) => {
    if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  };
  document.addEventListener('mousedown', handler);
  return () => document.removeEventListener('mousedown', handler);
}, [open]);
```
(현재 코드도 이 구조이면 OK — React가 unmount 시 cleanup 실행하므로 실제로는 안전할 수 있음. 확인 필요.)

---

## P3 — 개선 권장

### 16. gateway-manager.ts env 전체 전달

`env: { ...process.env }` → 필요한 변수만 명시적으로 전달.

### 17. 채널 config 구조 검증

POST /api/openclaw/channels에서 `config` 객체를 저장 전에 최소한 `JSON.stringify → JSON.parse` round-trip 검증.

### 18. fs 연산 에러 핸들링

`openclaw-sync.ts:332-393`의 rmSync/mkdirSync/writeFileSync를 try-catch로 감싸고, 구체적 에러 메시지 반환.

### 19. /api/openclaw/status에서 Promise.allSettled 사용

`Promise.all` → `Promise.allSettled`로 변경하여 VM 서버 다운 시에도 Gateway 상태는 표시.

### 20. SessionHistory agents .find() 최적화

`useMemo(() => new Map(agents.map(a => [a.id, a])), [agents])` 로 lookup Map 생성.

---

## 향후 작업 (Next)

### A. 채널별 라우팅 커스터마이징

현재 모든 채널이 orchestrator로 라우팅됨. 특정 채널을 특정 팀에 직접 연결하는 기능 필요:
- `openclaw_channels` 테이블에 `target_agent_id` 컬럼 추가
- sync 서비스에서 binding 생성 시 target 분기

### B. Gateway 자동 시작 연동

현재 Gateway는 수동 시작이 기본. electron-app 부팅 시 자동 시작 옵션:
- `gateway-manager.ts`에 `init()` 함수 존재하지만 호출처 없음
- Next.js instrumentation 또는 layout에서 호출

### C. 세션 히스토리 검색/필터

현재는 시간순 목록만 제공. 추가 기능:
- 에이전트별 필터
- 텍스트 검색 (chat_logs.content LIKE)
- 날짜 범위 필터
- 세션 삭제/내보내기

### D. OpenClaw config diff & 선택적 sync

현재 sync는 전체 재생성. 변경된 부분만 업데이트:
- `generateOpenClawConfig()` 결과를 stored와 diff
- 변경된 에이전트만 파일 재기록
- UI에서 diff 프리뷰 제공

### E. 실시간 Gateway 로그 스트리밍

Gateway 프로세스의 stdout/stderr를 WebSocket으로 프론트에 스트리밍:
- 디버깅, 에이전트 간 sessions_send 흐름 모니터링에 필요
- `gateway-manager.ts`에서 process stdout pipe 활용
