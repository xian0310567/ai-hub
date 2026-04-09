'use client';
import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface Schedule {
  id: string;
  name: string;
  cron_expr: string;
  task: string;
  enabled: number;
  last_run_at?: number;
  next_run_at?: number;
  created_at?: number;
}

const navLink: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)', textDecoration: 'none',
  padding: '4px 10px', border: '1px solid transparent', borderRadius: 4, transition: 'all .12s',
};

function cronHuman(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  if (dom === '*' && mon === '*') {
    if (dow === '*') return `매일 ${hour}:${min.padStart(2,'0')}`;
    if (dow === '1-5') return `평일(월~금) ${hour}:${min.padStart(2,'0')}`;
    if (dow === '1') return `매주 월요일 ${hour}:${min.padStart(2,'0')}`;
    if (dow === '5') return `매주 금요일 ${hour}:${min.padStart(2,'0')}`;
    return `주 ${dow}요일 ${hour}:${min.padStart(2,'0')}`;
  }
  if (dow === '*' && mon === '*') return `매월 ${dom}일 ${hour}:${min.padStart(2,'0')}`;
  return expr;
}

function tsToStr(ts?: number): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function SchedulesPage() {
  const router = useRouter();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editCron, setEditCron] = useState('');
  const [editErr, setEditErr] = useState('');

  const reload = useCallback(() => {
    fetch('/api/schedules').then(r => r.json()).then(d => {
      if (d.ok) setSchedules(d.schedules);
      else if (d.error === 'Unauthorized') router.replace('/login');
    });
  }, [router]);

  useEffect(() => {
    fetch('/api/auth/me').then(r => { if (!r.ok) router.replace('/login'); else reload(); })
      .catch(() => router.replace('/login'));
  }, [reload, router]);

  const toggleEnabled = async (id: string, current: number) => {
    await fetch('/api/schedules', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, enabled: current === 0 }),
    });
    reload();
  };

  const deleteSchedule = async (id: string, name: string) => {
    if (!confirm(`"${name}" 스케줄을 삭제할까요?`)) return;
    await fetch(`/api/schedules?id=${id}`, { method: 'DELETE' });
    reload();
  };

  const startEdit = (s: Schedule) => {
    setEditId(s.id);
    setEditName(s.name);
    setEditCron(s.cron_expr);
    setEditErr('');
  };

  const saveEdit = async () => {
    if (!editId) return;
    setLoading(true); setEditErr('');
    const r = await fetch('/api/schedules', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: editId, name: editName.trim() || undefined, cron_expr: editCron.trim() }),
    });
    const d = await r.json();
    if (d.ok) { setEditId(null); reload(); }
    else setEditErr(d.error || '저장 실패');
    setLoading(false);
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-canvas)' }}>
      <nav>
        <div className="nav-title">AI 사업부</div>
        <a href="/" style={navLink}>대시보드</a>
        <a href="/missions" style={navLink}>미션</a>
        <span style={{ ...navLink, color: 'var(--accent)', borderColor: 'var(--accent-dim)' }}>스케줄</span>
        <a href="/org" style={navLink}>조직 관리</a>
      </nav>

      <main style={{ maxWidth: 860, margin: '0 auto', padding: '32px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>🕐 반복 미션 스케줄</h1>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 12, padding: '2px 10px' }}>
            {schedules.filter(s => s.enabled).length}개 활성
          </span>
        </div>

        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 24, lineHeight: 1.6 }}>
          미션을 생성할 때 Claude가 반복 실행이 필요하다고 판단하면 자동으로 스케줄이 등록됩니다.<br />
          여기서 활성화/비활성화, cron 표현식 수정, 삭제가 가능합니다.
        </p>

        {schedules.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🕐</div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>등록된 스케줄 없음</div>
            <div style={{ fontSize: 12 }}>미션을 생성하면 Claude가 반복 여부를 자동으로 판단합니다</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {schedules.map(s => (
              <div key={s.id} style={{
                background: 'var(--bg-panel)', border: `1px solid ${s.enabled ? 'var(--border)' : 'var(--border-dim)'}`,
                borderRadius: 8, padding: '16px 20px',
                opacity: s.enabled ? 1 : 0.55, transition: 'opacity .15s',
              }}>
                {editId === s.id ? (
                  /* 편집 모드 */
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        placeholder="스케줄 이름"
                        style={{ flex: 1, background: 'var(--bg-canvas)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 10px', fontSize: 13, color: 'var(--text-primary)', fontFamily: 'inherit' }}
                      />
                      <input
                        value={editCron}
                        onChange={e => setEditCron(e.target.value)}
                        placeholder="cron (예: 0 9 * * 1-5)"
                        style={{ width: 180, background: 'var(--bg-canvas)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 10px', fontSize: 12, color: 'var(--text-primary)', fontFamily: 'monospace' }}
                      />
                    </div>
                    {editErr && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{editErr}</div>}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={saveEdit} disabled={loading} style={{ fontSize: 12, fontWeight: 600, padding: '5px 14px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit' }}>저장</button>
                      <button onClick={() => setEditId(null)} style={{ fontSize: 12, padding: '5px 12px', background: 'none', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', color: 'var(--text-muted)', fontFamily: 'inherit' }}>취소</button>
                    </div>
                  </div>
                ) : (
                  /* 표시 모드 */
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
                    {/* 토글 */}
                    <button
                      onClick={() => toggleEnabled(s.id, s.enabled)}
                      title={s.enabled ? '비활성화' : '활성화'}
                      style={{
                        width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer',
                        background: s.enabled ? 'var(--accent)' : 'var(--border)',
                        position: 'relative', flexShrink: 0, marginTop: 2, transition: 'background .15s',
                      }}
                    >
                      <span style={{
                        position: 'absolute', top: 2, left: s.enabled ? 18 : 2,
                        width: 16, height: 16, borderRadius: '50%', background: '#fff',
                        transition: 'left .15s',
                      }} />
                    </button>

                    {/* 내용 */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{s.name}</span>
                        <code style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-canvas)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 6px' }}>{s.cron_expr}</code>
                        <span style={{ fontSize: 11, color: 'var(--accent)' }}>{cronHuman(s.cron_expr)}</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.task}
                      </div>
                      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)' }}>
                        <span>마지막 실행: {tsToStr(s.last_run_at)}</span>
                        <span>다음 실행: <strong style={{ color: s.enabled ? 'var(--text-secondary)' : 'var(--text-muted)' }}>{tsToStr(s.next_run_at)}</strong></span>
                      </div>
                    </div>

                    {/* 액션 */}
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <button onClick={() => startEdit(s)} style={{ fontSize: 11, padding: '4px 10px', background: 'none', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', color: 'var(--text-muted)', fontFamily: 'inherit' }}>수정</button>
                      <button onClick={() => deleteSchedule(s.id, s.name)} style={{ fontSize: 11, padding: '4px 10px', background: 'none', border: '1px solid var(--danger)', borderRadius: 4, cursor: 'pointer', color: 'var(--danger)', fontFamily: 'inherit' }}>삭제</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* cron 참고표 */}
        <div style={{ marginTop: 40, padding: '16px 20px', background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 10 }}>cron 표현식 참고</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 24px', fontSize: 11 }}>
            {[
              ['0 9 * * 1-5', '평일 오전 9시'],
              ['0 9 * * 1', '매주 월요일 오전 9시'],
              ['0 8 * * *', '매일 오전 8시'],
              ['0 18 * * 5', '매주 금요일 오후 6시'],
              ['0 9 1 * *', '매월 1일 오전 9시'],
              ['0 */4 * * *', '4시간마다'],
            ].map(([expr, label]) => (
              <div key={expr} style={{ display: 'flex', gap: 8, color: 'var(--text-muted)', padding: '2px 0' }}>
                <code style={{ color: 'var(--accent)', minWidth: 130 }}>{expr}</code>
                <span>{label}</span>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
