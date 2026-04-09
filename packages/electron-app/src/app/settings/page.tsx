'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

// ── 타입 ──────────────────────────────────────────────────────────
interface Host  { id: string; name: string; status: string; last_heartbeat: number; username: string; }
interface AuditLog { id: string; action: string; resource: string; resource_id: string; meta: string; created_at: number; username?: string; }
interface Team  { id: string; name: string; workspace_id: string; }
interface Member { id: string; username: string; role: string; joined_at: number; }
interface OrgMember { id: string; username: string; role: string; joined_at: number; }

// ── 공통 스타일 ───────────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  page:   { minHeight: '100vh', background: 'var(--bg-canvas)', color: 'var(--text-primary)', fontFamily: "'Inter', -apple-system, sans-serif", display: 'flex', flexDirection: 'column' },
  hdr:    { height: 54, display: 'flex', alignItems: 'center', gap: 12, padding: '0 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg-panel)', flexShrink: 0 },
  body:   { display: 'flex', flex: 1, overflow: 'hidden' },
  nav:    { width: 180, borderRight: '1px solid var(--border)', background: 'var(--bg-panel)', padding: '12px 0', flexShrink: 0 },
  main:   { flex: 1, overflowY: 'auto' as const, padding: '24px 28px' },
  navItem:{ display: 'block', padding: '8px 16px', fontSize: 13, fontWeight: 500, cursor: 'pointer', transition: 'all .1s', border: 'none', background: 'none', color: 'var(--text-secondary)', fontFamily: 'inherit', textAlign: 'left' as const, width: '100%' },
  card:   { background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 16 },
  tblHdr: { display: 'grid', padding: '8px 14px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', background: 'var(--bg-elevated)' },
  tblRow: { display: 'grid', padding: '10px 14px', fontSize: 13, alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', transition: 'background .1s' },
  badge:  { display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase' as const },
  input:  { background: 'var(--bg-canvas)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13, padding: '7px 10px', borderRadius: 4, outline: 'none' },
  btn:    { fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit' },
  btnSm:  { fontSize: 11, fontWeight: 500, background: 'none', color: 'var(--text-secondary)', border: '1px solid var(--border)', padding: '3px 7px', borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit' },
  btnDel: { fontSize: 11, fontWeight: 500, background: 'none', color: 'var(--danger)', border: '1px solid var(--danger)', padding: '3px 7px', borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit' },
  sec:    { fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 },
  hint:   { fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 },
};

const HOST_COLOR: Record<string, string> = { idle: '#14ae5c', busy: '#0d99ff', offline: '#616161', draining: '#f59e0b' };
const HOST_LABEL: Record<string, string> = { idle: '대기', busy: '작업중', offline: '오프라인', draining: '종료중' };
const ROLE_COLOR: Record<string, string> = { org_admin: '#f59e0b', team_admin: '#9747ff', member: '#14ae5c' };
const ROLE_LABEL: Record<string, string> = { org_admin: 'Org 관리자', team_admin: '팀 관리자', member: '멤버' };

// ── Hosts 탭 ─────────────────────────────────────────────────────
function HostsTab() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/hosts').then(r => r.json()).catch(() => []);
    if (Array.isArray(r)) setHosts(r);
  }, []);

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 10000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [load]);

  const fmt = (ts: number) => {
    const s = Math.floor(Date.now() / 1000) - ts;
    if (s < 60) return `${s}초 전`;
    if (s < 3600) return `${Math.floor(s / 60)}분 전`;
    return `${Math.floor(s / 3600)}시간 전`;
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <span style={S.sec}>호스트 상태</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>10초마다 자동 갱신</span>
        <button style={{ ...S.btnSm, marginLeft: 'auto' }} onClick={load}>새로고침</button>
      </div>
      <div style={S.hint}>각 사용자 PC에서 실행 중인 데몬의 현재 상태입니다.</div>

      {hosts.length === 0 ? (
        <div style={{ ...S.card, padding: '32px', textAlign: 'center' }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>💻</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>등록된 호스트가 없습니다</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>Electron 앱을 실행하면 자동 등록됩니다</div>
        </div>
      ) : (
        <div style={S.card}>
          <div style={{ ...S.tblHdr, gridTemplateColumns: '2fr 1fr 1fr 1fr' }}>
            <span>호스트</span><span>사용자</span><span>상태</span><span>마지막 핑</span>
          </div>
          {hosts.map(h => (
            <div key={h.id} style={{ ...S.tblRow, gridTemplateColumns: '2fr 1fr 1fr 1fr' }}
              onMouseOver={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
              <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-primary)' }}>{h.name}</span>
              <span style={{ color: 'var(--text-secondary)' }}>{h.username}</span>
              <span>
                <span style={{ ...S.badge, background: `${HOST_COLOR[h.status] ?? '#616161'}22`, color: HOST_COLOR[h.status] ?? '#616161' }}>
                  {HOST_LABEL[h.status] ?? h.status}
                </span>
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                {h.last_heartbeat ? fmt(h.last_heartbeat) : '-'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Audit Log 탭 ──────────────────────────────────────────────────
function AuditTab() {
  const [logs,   setLogs]   = useState<AuditLog[]>([]);
  const [filter, setFilter] = useState({ action: '', resource: '', user_id: '' });
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<AuditLog | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (filter.action)   qs.set('action', filter.action);
    if (filter.resource) qs.set('resource', filter.resource);
    if (filter.user_id)  qs.set('user_id', filter.user_id);
    qs.set('limit', '200');
    const r = await fetch(`/api/audit?${qs}`).then(r => r.json()).catch(() => []);
    setLoading(false);
    if (Array.isArray(r)) setLogs(r);
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const fmt = (ts: number) => new Date(ts * 1000).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const ACTION_COLOR: Record<string, string> = {
    'vault.secret.write': '#9747ff', 'vault.lease': '#0d99ff',
    'task.create': '#14ae5c', 'member.add': '#f59e0b',
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <span style={S.sec}>Audit Log</span>
        <button style={{ ...S.btnSm, marginLeft: 'auto' }} onClick={load}>새로고침</button>
      </div>

      {/* 필터 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input style={{ ...S.input, flex: 1 }} placeholder="액션 (예: vault, task...)"
          value={filter.action} onChange={e => setFilter(f => ({ ...f, action: e.target.value }))}
          onKeyDown={e => e.key === 'Enter' && load()} />
        <input style={{ ...S.input, flex: 1 }} placeholder="리소스 타입"
          value={filter.resource} onChange={e => setFilter(f => ({ ...f, resource: e.target.value }))}
          onKeyDown={e => e.key === 'Enter' && load()} />
        <button style={S.btn} onClick={load}>검색</button>
      </div>

      {loading && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>로딩 중...</div>}

      {logs.length === 0 && !loading ? (
        <div style={{ ...S.card, padding: '32px', textAlign: 'center' }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>감사 로그가 없습니다</div>
        </div>
      ) : (
        <div style={S.card}>
          <div style={{ ...S.tblHdr, gridTemplateColumns: '2fr 1fr 1fr 1.5fr' }}>
            <span>액션</span><span>리소스</span><span>사용자</span><span>시각</span>
          </div>
          {logs.map(log => (
            <div key={log.id}
              style={{ ...S.tblRow, gridTemplateColumns: '2fr 1fr 1fr 1.5fr', cursor: 'pointer' }}
              onClick={() => setDetail(detail?.id === log.id ? null : log)}
              onMouseOver={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseOut={e => e.currentTarget.style.background = detail?.id === log.id ? 'var(--bg-active)' : 'transparent'}>
              <span style={{ fontFamily: 'monospace', fontSize: 12, color: ACTION_COLOR[log.action] ?? 'var(--text-secondary)' }}>{log.action}</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{log.resource}</span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{log.username ?? '-'}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmt(log.created_at)}</span>
            </div>
          ))}
        </div>
      )}

      {detail && (
        <div style={{ ...S.card, padding: '14px 16px', marginTop: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8 }}>상세 정보</div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--accent)', whiteSpace: 'pre-wrap', background: 'var(--bg-canvas)', padding: '10px 12px', borderRadius: 4 }}>
            {JSON.stringify(JSON.parse(detail.meta || '{}'), null, 2)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>리소스 ID: {detail.resource_id}</div>
        </div>
      )}
    </div>
  );
}

// ── Team Membership 탭 ────────────────────────────────────────────
function TeamMembersTab({ userRole, orgId }: { userRole: string; orgId: string }) {
  const [teams,    setTeams]    = useState<Team[]>([]);
  const [selTeam,  setSelTeam]  = useState('');
  const [members,  setMembers]  = useState<Member[]>([]);
  const [addUserId, setAddUserId] = useState('');
  const [addRole,  setAddRole]  = useState('member');

  const canManage = userRole === 'org_admin' || userRole === 'team_admin';

  useEffect(() => {
    fetch('/api/teams').then(r => r.json()).then(d => {
      if (Array.isArray(d)) setTeams(d);
    }).catch(() => {});
  }, []);

  const loadMembers = useCallback(async (teamId: string) => {
    const r = await fetch(`/api/teams/${teamId}/members`).then(r => r.json()).catch(() => []);
    if (Array.isArray(r)) setMembers(r);
  }, []);

  useEffect(() => {
    if (selTeam) loadMembers(selTeam);
  }, [selTeam, loadMembers]);

  const addMember = async () => {
    if (!selTeam || !addUserId.trim()) return;
    await fetch(`/api/teams/${selTeam}/members`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: addUserId.trim(), role: addRole }),
    });
    setAddUserId('');
    loadMembers(selTeam);
  };

  const removeMember = async (userId: string) => {
    if (!selTeam || !confirm('멤버를 제거하시겠습니까?')) return;
    await fetch(`/api/teams/${selTeam}/members/${userId}`, { method: 'DELETE' });
    loadMembers(selTeam);
  };

  const fmt = (ts: number) => new Date(ts * 1000).toLocaleDateString('ko-KR');

  return (
    <div>
      <div style={{ marginBottom: 16 }}><span style={S.sec}>팀 멤버십</span></div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>팀 선택</div>
        <select style={{ ...S.input, cursor: 'pointer', width: 280 }} value={selTeam} onChange={e => setSelTeam(e.target.value)}>
          <option value="">-- 팀을 선택하세요 --</option>
          {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>

      {selTeam && (
        <>
          {canManage && (
            <div style={{ ...S.card, padding: '14px 16px', marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 10 }}>멤버 추가</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input style={{ ...S.input, flex: 1 }} placeholder="User ID" value={addUserId} onChange={e => setAddUserId(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addMember()} />
                <select style={{ ...S.input, cursor: 'pointer', width: 120 }} value={addRole} onChange={e => setAddRole(e.target.value)}>
                  <option value="member">멤버</option>
                  <option value="team_admin">팀 관리자</option>
                </select>
                <button style={S.btn} onClick={addMember}>추가</button>
              </div>
            </div>
          )}

          <div style={S.card}>
            <div style={{ ...S.tblHdr, gridTemplateColumns: '2fr 1fr 1fr 80px' }}>
              <span>사용자</span><span>역할</span><span>가입일</span><span></span>
            </div>
            {members.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>멤버가 없습니다</div>
            ) : members.map(m => (
              <div key={m.id} style={{ ...S.tblRow, gridTemplateColumns: '2fr 1fr 1fr 80px' }}
                onMouseOver={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
                <span style={{ color: 'var(--text-primary)' }}>{m.username}</span>
                <span><span style={{ ...S.badge, background: `${ROLE_COLOR[m.role] ?? '#616161'}22`, color: ROLE_COLOR[m.role] ?? '#9d9d9d' }}>{ROLE_LABEL[m.role] ?? m.role}</span></span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmt(m.joined_at)}</span>
                <span>
                  {canManage && (
                    <button style={S.btnDel} onClick={() => removeMember(m.id)}>제거</button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Org Members 탭 ────────────────────────────────────────────────
function OrgMembersTab({ userRole, orgId }: { userRole: string; orgId: string }) {
  const [members, setMembers] = useState<OrgMember[]>([]);
  const isAdmin = userRole === 'org_admin';

  const load = useCallback(async () => {
    if (!orgId) return;
    const r = await fetch(`/api/orgs/members?orgId=${orgId}`).then(r => r.json()).catch(() => []);
    if (Array.isArray(r)) setMembers(r);
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const changeRole = async (userId: string, role: string) => {
    await fetch('/api/orgs/members', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId, userId, role }),
    });
    load();
  };

  const removeMember = async (userId: string) => {
    if (!confirm('조직에서 멤버를 제거하시겠습니까?')) return;
    await fetch(`/api/orgs/members?orgId=${orgId}&userId=${userId}`, { method: 'DELETE' });
    load();
  };

  const fmt = (ts: number) => new Date(ts * 1000).toLocaleDateString('ko-KR');

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <span style={S.sec}>조직 멤버</span>
        {!isAdmin && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>(역할 변경은 org_admin만 가능)</span>}
      </div>

      <div style={S.card}>
        <div style={{ ...S.tblHdr, gridTemplateColumns: '2fr 1.5fr 1fr 100px' }}>
          <span>사용자</span><span>역할</span><span>가입일</span><span></span>
        </div>
        {members.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>멤버가 없습니다</div>
        ) : members.map(m => (
          <div key={m.id} style={{ ...S.tblRow, gridTemplateColumns: '2fr 1.5fr 1fr 100px' }}
            onMouseOver={e => e.currentTarget.style.background = 'var(--bg-hover)'}
            onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
            <span style={{ color: 'var(--text-primary)' }}>{m.username}</span>
            <span>
              {isAdmin ? (
                <select style={{ ...S.input, fontSize: 12, padding: '3px 7px', cursor: 'pointer' }}
                  value={m.role} onChange={e => changeRole(m.id, e.target.value)}>
                  <option value="org_admin">Org 관리자</option>
                  <option value="team_admin">팀 관리자</option>
                  <option value="member">멤버</option>
                </select>
              ) : (
                <span style={{ ...S.badge, background: `${ROLE_COLOR[m.role] ?? '#616161'}22`, color: ROLE_COLOR[m.role] ?? '#9d9d9d' }}>{ROLE_LABEL[m.role] ?? m.role}</span>
              )}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmt(m.joined_at)}</span>
            <span>
              {isAdmin && (
                <button style={S.btnDel} onClick={() => removeMember(m.id)}>제거</button>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 백업 탭 ──────────────────────────────────────────────────────
interface BackupEntry { timestamp: string; size: number; created_at: number; }

function BackupTab() {
  const [backups,  setBackups]  = useState<BackupEntry[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [running,  setRunning]  = useState(false);
  const [lastMsg,  setLastMsg]  = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetch('/api/backup').then(r => r.json()).catch(() => ({ ok: false }));
    setLoading(false);
    if (r.ok) setBackups(r.backups ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const runBackup = async () => {
    setRunning(true);
    setLastMsg('');
    const r = await fetch('/api/backup', { method: 'POST' }).then(r => r.json()).catch(() => ({ ok: false }));
    setRunning(false);
    if (r.ok) {
      setLastMsg(`백업 완료: ${r.timestamp}`);
      load();
    } else {
      setLastMsg('백업 실패: ' + (r.error ?? '알 수 없는 오류'));
    }
  };

  const fmtSize = (b: number) => b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(2)} MB`;
  const fmtTs   = (ts: string) => {
    const parts = ts.replace('T', ' ').split('-');
    return `${parts[0]}-${parts[1]}-${parts[2]} ${parts[3]}:${parts[4]}`;
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <span style={S.sec}>SQLite 백업</span>
        <button style={{ ...S.btn, marginLeft: 'auto' }} onClick={runBackup} disabled={running}>
          {running ? '백업 중...' : '지금 백업'}
        </button>
        <button style={S.btnSm} onClick={load}>새로고침</button>
      </div>
      <div style={S.hint}>
        트레이 최소화 상태에서 1시간마다 자동 백업됩니다. 최대 10개를 보관하며, 새 PC에서 복원할 수 있습니다.
      </div>

      {lastMsg && (
        <div style={{ fontSize: 12, color: lastMsg.startsWith('백업 완료') ? 'var(--accent)' : 'var(--danger)', marginBottom: 12, padding: '8px 12px', background: 'var(--bg-elevated)', borderRadius: 6 }}>
          {lastMsg}
        </div>
      )}

      {loading && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>로딩 중...</div>}

      {backups.length === 0 && !loading ? (
        <div style={{ ...S.card, padding: '32px', textAlign: 'center' as const }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>💾</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>백업 기록이 없습니다</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>우측 상단의 "지금 백업" 버튼을 눌러 시작하세요</div>
        </div>
      ) : (
        <div style={S.card}>
          <div style={{ ...S.tblHdr, gridTemplateColumns: '2.5fr 1fr 1fr' }}>
            <span>백업 시각</span><span>크기</span><span>다운로드</span>
          </div>
          {backups.map((b, i) => (
            <div key={b.timestamp} style={{ ...S.tblRow, gridTemplateColumns: '2.5fr 1fr 1fr' }}
              onMouseOver={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
              <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-primary)' }}>
                {fmtTs(b.timestamp)}
                {i === 0 && <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--accent)', fontFamily: 'sans-serif', fontWeight: 700 }}>최신</span>}
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmtSize(b.size)}</span>
              <span>
                <a href={`/api/backup?download=${b.timestamp}`} download
                  style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none' }}>
                  다운로드
                </a>
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ ...S.card, padding: '14px 16px', marginTop: 16, background: 'var(--bg-elevated)' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8 }}>복원 방법</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.8 }}>
          1. 새 PC에 AI Hub를 설치하고 동일 계정으로 로그인합니다<br />
          2. 설정 → 백업 탭에서 원하는 백업을 다운로드합니다<br />
          3. 다운로드된 <code style={{ fontFamily: 'monospace', background: 'var(--bg-canvas)', padding: '1px 5px', borderRadius: 3 }}>.db</code> 파일을 <code style={{ fontFamily: 'monospace', background: 'var(--bg-canvas)', padding: '1px 5px', borderRadius: 3 }}>.data/local.db</code>로 교체합니다<br />
          4. 앱을 재시작합니다
        </div>
      </div>
    </div>
  );
}

// ── MCP 서버 탭 ───────────────────────────────────────────────────
interface McpConfig { id: string; name: string; label: string; command: string; args: string; env_json: string; enabled: number; }

function McpTab() {
  const [configs, setConfigs] = useState<McpConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ name: '', label: '', command: '', args: '', env: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    fetch('/api/mcp-configs').then(r => r.json()).then(d => { setConfigs(d.configs ?? []); setLoading(false); });
  }, []);
  useEffect(load, [load]);

  const toggle = async (cfg: McpConfig) => {
    await fetch(`/api/mcp-configs/${cfg.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !cfg.enabled }) });
    load();
  };
  const del = async (id: string) => {
    if (!confirm('삭제하시겠습니까?')) return;
    await fetch(`/api/mcp-configs/${id}`, { method: 'DELETE' });
    load();
  };
  const add = async () => {
    if (!form.name || !form.command) { setErr('이름과 command는 필수입니다'); return; }
    setSaving(true); setErr('');
    try {
      let args: string[] = [];
      if (form.args.trim()) args = form.args.split(/\s+/);
      let env: Record<string, string> = {};
      if (form.env.trim()) {
        for (const line of form.env.split('\n')) {
          const eq = line.indexOf('=');
          if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
      }
      const res = await fetch('/api/mcp-configs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: form.name, label: form.label || form.name, command: form.command, args, env }) });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      setForm({ name: '', label: '', command: '', args: '', env: '' });
      load();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  if (loading) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>로딩 중…</div>;

  return (
    <div>
      <div style={S.sec}>🔌 MCP 서버 설정</div>
      <div style={S.hint}>Claude CLI에 연결할 MCP(Model Context Protocol) 서버를 등록합니다. 미션 실행 시 자동으로 --mcp-config로 전달됩니다.</div>

      {/* 목록 */}
      {configs.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20 }}>등록된 MCP 서버가 없습니다.</div>
      ) : (
        <div style={{ ...S.card, marginBottom: 24 }}>
          <div style={{ ...S.tblHdr, gridTemplateColumns: '1fr 1.5fr 2fr 80px 90px' }}>
            <span>이름</span><span>레이블</span><span>Command</span><span>상태</span><span></span>
          </div>
          {configs.map(c => (
            <div key={c.id} style={{ ...S.tblRow, gridTemplateColumns: '1fr 1.5fr 2fr 80px 90px' }}>
              <span style={{ fontWeight: 600 }}>{c.name}</span>
              <span style={{ color: 'var(--text-secondary)' }}>{c.label}</span>
              <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-muted)' }}>{c.command} {JSON.parse(c.args || '[]').join(' ')}</span>
              <span>
                <button onClick={() => toggle(c)} style={{ ...S.btnSm, color: c.enabled ? 'var(--success, #4caf50)' : 'var(--text-muted)' }}>
                  {c.enabled ? '✓ 활성' : '비활성'}
                </button>
              </span>
              <span>
                <button onClick={() => del(c.id)} style={S.btnDel}>삭제</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 추가 폼 */}
      <div style={{ ...S.card, padding: 18 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>새 MCP 서버 추가</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <input style={S.input} placeholder="서버 이름 (예: filesystem)" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          <input style={S.input} placeholder="레이블 (선택)" value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} />
        </div>
        <div style={{ marginBottom: 10 }}>
          <input style={{ ...S.input, width: '100%' }} placeholder="command (예: npx)" value={form.command} onChange={e => setForm(f => ({ ...f, command: e.target.value }))} />
        </div>
        <div style={{ marginBottom: 10 }}>
          <input style={{ ...S.input, width: '100%' }} placeholder="args (공백 구분, 예: @modelcontextprotocol/server-filesystem /tmp)" value={form.args} onChange={e => setForm(f => ({ ...f, args: e.target.value }))} />
        </div>
        <div style={{ marginBottom: 14 }}>
          <textarea style={{ ...S.input, width: '100%', minHeight: 60 }} placeholder={"환경변수 (KEY=VALUE, 줄바꿈 구분)\nAPI_KEY=your-key"} value={form.env} onChange={e => setForm(f => ({ ...f, env: e.target.value }))} />
        </div>
        {err && <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 10 }}>{err}</div>}
        <button style={S.btn} onClick={add} disabled={saving}>{saving ? '저장 중…' : '추가'}</button>
      </div>
    </div>
  );
}

// ── 메인 페이지 ───────────────────────────────────────────────────
const TABS = [
  { id: 'hosts',      label: '💻 호스트 상태' },
  { id: 'audit',      label: '📋 Audit Log' },
  { id: 'team-members', label: '👥 팀 멤버십' },
  { id: 'org-members',  label: '🏢 조직 멤버' },
  { id: 'backup',       label: '💾 백업' },
  { id: 'mcp',          label: '🔌 MCP 서버' },
];

function SettingsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tab, setTab]           = useState(searchParams.get('tab') || 'hosts');
  const [userRole, setUserRole] = useState('member');
  const [orgId,    setOrgId]    = useState('');

  useEffect(() => {
    fetch('/api/auth/me').then(async r => {
      if (!r.ok) { router.replace('/login'); return; }
      const d = await r.json();
      setUserRole(d.orgs?.[0]?.role ?? 'member');
      setOrgId(d.orgs?.[0]?.org_id ?? '');
    }).catch(() => router.replace('/login'));
  }, [router]);

  const changeTab = (t: string) => {
    setTab(t);
    window.history.replaceState(null, '', `?tab=${t}`);
  };

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.hdr}>
        <a href="/" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', textDecoration: 'none' }}
          onMouseOver={e => e.currentTarget.style.color = 'var(--text-primary)'}
          onMouseOut={e => e.currentTarget.style.color = 'var(--text-muted)'}>← 대시보드</a>
        <span style={{ color: 'var(--border)' }}>|</span>
        <span style={{ fontSize: 14, fontWeight: 700 }}>⚙️ 설정</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)', background: `${ROLE_COLOR[userRole] ?? '#616161'}22`, border: `1px solid ${ROLE_COLOR[userRole] ?? '#616161'}44`, padding: '2px 8px', borderRadius: 10 }}>
          {ROLE_LABEL[userRole] ?? userRole}
        </span>
      </div>

      <div style={S.body}>
        {/* Side nav */}
        <div style={S.nav}>
          {TABS.map(t => (
            <button key={t.id} style={{
              ...S.navItem,
              color: tab === t.id ? 'var(--text-primary)' : 'var(--text-secondary)',
              background: tab === t.id ? 'var(--bg-active)' : 'none',
              borderLeft: tab === t.id ? '3px solid var(--accent)' : '3px solid transparent',
            }}
              onClick={() => changeTab(t.id)}
              onMouseOver={e => { if (tab !== t.id) e.currentTarget.style.background = 'var(--bg-hover)'; }}
              onMouseOut={e => { if (tab !== t.id) e.currentTarget.style.background = 'none'; }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={S.main}>
          {tab === 'hosts'        && <HostsTab />}
          {tab === 'audit'        && <AuditTab />}
          {tab === 'team-members' && <TeamMembersTab userRole={userRole} orgId={orgId} />}
          {tab === 'org-members'  && <OrgMembersTab userRole={userRole} orgId={orgId} />}
          {tab === 'backup'       && <BackupTab />}
          {tab === 'mcp'          && <McpTab />}
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: 'var(--bg-canvas)' }} />}>
      <SettingsContent />
    </Suspense>
  );
}
