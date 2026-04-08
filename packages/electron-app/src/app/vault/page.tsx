'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface Vault {
  id: string; name: string; scope: string; team_id?: string; owner_user_id?: string;
  description: string; expires_at?: number; created_at: number;
}
interface Secret { id: string; key_name: string; created_at: number; updated_at: number; revealed?: string | null; }

const SCOPE_LABEL: Record<string, string> = { org: '조직', team: '팀', personal_meta: '개인(메타)' };
const SCOPE_COLOR: Record<string, string> = { org: '#0d99ff', team: '#9747ff', personal_meta: '#14ae5c' };

const s: Record<string, React.CSSProperties> = {
  page:    { minHeight: '100vh', background: 'var(--bg-canvas)', color: 'var(--text-primary)', fontFamily: "'Inter', -apple-system, sans-serif", display: 'flex', flexDirection: 'column' },
  header:  { height: 44, display: 'flex', alignItems: 'center', gap: 12, padding: '0 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg-panel)', flexShrink: 0 },
  body:    { display: 'flex', flex: 1, overflow: 'hidden' },
  sidebar: { width: 260, borderRight: '1px solid var(--border)', background: 'var(--bg-panel)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  main:    { flex: 1, overflow: 'auto', padding: 24 },
  sideHdr: { padding: '12px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 },
  vaultList: { flex: 1, overflowY: 'auto' as const },
  vaultItem: { padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid var(--border-subtle)', transition: 'background .1s' },
  btn:     { fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: '#fff', border: 'none', padding: '5px 10px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit' },
  btnSm:   { fontSize: 12, fontWeight: 500, background: 'none', color: 'var(--text-secondary)', border: '1px solid var(--border)', padding: '4px 8px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit' },
  btnDanger: { fontSize: 12, fontWeight: 500, background: 'none', color: 'var(--danger)', border: '1px solid var(--danger)', padding: '4px 8px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit' },
  card:    { background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, padding: '18px 20px', marginBottom: 16 },
  label:   { fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: '0.05em', marginBottom: 6 },
  input:   { background: 'var(--bg-canvas)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13, padding: '7px 10px', borderRadius: 4, outline: 'none', width: '100%', boxSizing: 'border-box' as const },
  tag:     { display: 'inline-block', fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10, textTransform: 'uppercase' as const },
  secretRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 5, marginBottom: 6 },
  mono:    { fontFamily: 'monospace', fontSize: 13, color: 'var(--accent)', flex: 1 },
  muted:   { fontSize: 11, color: 'var(--text-muted)' },
  overlay: { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(3px)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  modal:   { background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 28, width: 480, display: 'flex', flexDirection: 'column', gap: 16, boxShadow: '0 20px 60px rgba(0,0,0,.5)' },
};

export default function VaultPage() {
  const router = useRouter();
  const [vaults,   setVaults]   = useState<Vault[]>([]);
  const [selected, setSelected] = useState<Vault | null>(null);
  const [secrets,  setSecrets]  = useState<Secret[]>([]);
  const [userRole, setUserRole] = useState('member');
  const [userId,   setUserId]   = useState('');
  const [orgId,    setOrgId]    = useState('');

  // Modals
  const [showCreateVault, setShowCreateVault] = useState(false);
  const [showAddSecret,   setShowAddSecret]   = useState(false);
  const [newVault,   setNewVault]   = useState({ name: '', scope: 'org', description: '' });
  const [newSecret,  setNewSecret]  = useState({ key_name: '', value: '' });
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState('');
  const [revealing,  setRevealing]  = useState<string | null>(null); // secretId being revealed

  const isPersonalVault = selected?.scope === 'personal_meta' && selected?.owner_user_id === userId;
  const canWrite = userRole === 'org_admin' || userRole === 'team_admin' || isPersonalVault;
  const canDeleteVault = userRole === 'org_admin' || isPersonalVault;

  const loadVaults = useCallback(async () => {
    const r = await fetch('/api/vaults').then(r => r.json()).catch(() => ({}));
    if (Array.isArray(r)) setVaults(r);
  }, []);

  const loadSecrets = useCallback(async (vaultId: string) => {
    const r = await fetch(`/api/vaults/${vaultId}`).then(r => r.json()).catch(() => ([]));
    if (Array.isArray(r)) setSecrets(r);
  }, []);

  useEffect(() => {
    fetch('/api/auth/me').then(async r => {
      if (!r.ok) { router.replace('/login'); return; }
      const d = await r.json();
      setUserRole(d.orgs?.[0]?.role ?? 'member');
      setOrgId(d.orgs?.[0]?.org_id ?? '');
      setUserId(d.id ?? '');
      loadVaults();
    }).catch(() => router.replace('/login'));
  }, [router, loadVaults]);

  const selectVault = (v: Vault) => {
    setSelected(v);
    loadSecrets(v.id);
  };

  const createVault = async () => {
    if (!newVault.name.trim()) return;
    setSaving(true); setError('');
    const r = await fetch('/api/vaults', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newVault),
    }).then(r => r.json()).catch(() => ({}));
    setSaving(false);
    if (r.id) { setShowCreateVault(false); setNewVault({ name: '', scope: 'org', description: '' }); loadVaults(); }
    else setError(r.error || '생성 실패');
  };

  const deleteVault = async (id: string) => {
    if (!confirm('Vault를 삭제하면 모든 시크릿이 사라집니다. 계속하시겠습니까?')) return;
    await fetch(`/api/vaults/${id}`, { method: 'DELETE' });
    if (selected?.id === id) setSelected(null);
    loadVaults();
  };

  const addSecret = async () => {
    if (!newSecret.key_name.trim() || !newSecret.value.trim() || !selected) return;
    setSaving(true); setError('');

    // personal_meta vault: 로컬 키체인에 저장
    const endpoint = isPersonalVault
      ? `/api/vaults/${selected.id}/personal-secrets`
      : `/api/vaults/${selected.id}/secrets`;

    const r = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSecret),
    }).then(r => r.json()).catch(() => ({}));
    setSaving(false);
    if (r.ok) { setShowAddSecret(false); setNewSecret({ key_name: '', value: '' }); loadSecrets(selected.id); }
    else setError(r.error || '저장 실패');
  };

  const deleteSecret = async (secretId: string, keyName?: string) => {
    if (!selected) return;
    const url = isPersonalVault
      ? `/api/vaults/${selected.id}/personal-secrets/${secretId}?key_name=${encodeURIComponent(keyName ?? '')}`
      : `/api/vaults/${selected.id}/secrets/${secretId}`;
    await fetch(url, { method: 'DELETE' });
    loadSecrets(selected.id);
  };

  const revealSecret = async (secretId: string, keyName: string) => {
    if (!selected || !isPersonalVault) return;
    setRevealing(secretId);
    const r = await fetch(`/api/vaults/${selected.id}/personal-secrets?key_name=${encodeURIComponent(keyName)}`)
      .then(r => r.json()).catch(() => ({})) as { value?: string | null };
    setSecrets(prev => prev.map(s => s.id === secretId ? { ...s, revealed: r.value ?? null } : s));
    setRevealing(null);
  };

  const fmt = (ts: number) => new Date(ts * 1000).toLocaleDateString('ko-KR');

  return (
    <div style={s.page}>
      {/* Header */}
      <div style={s.header}>
        <a href="/" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', textDecoration: 'none' }}
          onMouseOver={e => e.currentTarget.style.color = 'var(--text-primary)'}
          onMouseOut={e => e.currentTarget.style.color = 'var(--text-muted)'}>← 대시보드</a>
        <span style={{ color: 'var(--border)' }}>|</span>
        <span style={{ fontSize: 14, fontWeight: 700 }}>🔐 Vault 관리</span>
        <a href="/settings" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)', textDecoration: 'none' }}>설정 →</a>
      </div>

      <div style={s.body}>
        {/* Sidebar */}
        <div style={s.sidebar}>
          <div style={s.sideHdr}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Vaults</span>
            {/* 모든 사용자가 개인 Vault 생성 가능; org_admin/team_admin은 org/team도 가능 */}
            <button style={s.btn} onClick={() => setShowCreateVault(true)}>+ 생성</button>
          </div>
          <div style={s.vaultList}>
            {vaults.length === 0 && (
              <div style={{ padding: '20px 14px', fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
                {canWrite ? 'Vault가 없습니다.\n+ 생성으로 추가하세요.' : 'Vault가 없습니다.'}
              </div>
            )}
            {vaults.map(v => (
              <div key={v.id}
                style={{ ...s.vaultItem, background: selected?.id === v.id ? 'var(--bg-active)' : 'transparent', borderLeft: selected?.id === v.id ? '3px solid var(--accent)' : '3px solid transparent' }}
                onClick={() => selectVault(v)}
                onMouseOver={e => { if (selected?.id !== v.id) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseOut={e => { if (selected?.id !== v.id) e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</span>
                  <span style={{ ...s.tag, background: `${SCOPE_COLOR[v.scope]}22`, color: SCOPE_COLOR[v.scope] }}>{SCOPE_LABEL[v.scope] ?? v.scope}</span>
                </div>
                {v.description && <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.description}</div>}
              </div>
            ))}
          </div>
        </div>

        {/* Main content */}
        <div style={s.main}>
          {!selected ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 40 }}>🔐</div>
              <div style={{ fontSize: 15, color: 'var(--text-muted)' }}>좌측에서 Vault를 선택하세요</div>
            </div>
          ) : (
            <>
              {/* Vault Info */}
              <div style={s.card}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                      <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{selected.name}</span>
                      <span style={{ ...s.tag, background: `${SCOPE_COLOR[selected.scope]}22`, color: SCOPE_COLOR[selected.scope] }}>{SCOPE_LABEL[selected.scope] ?? selected.scope}</span>
                    </div>
                    {selected.description && <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>{selected.description}</div>}
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>생성일: {fmt(selected.created_at)}{selected.expires_at ? ` · 만료: ${fmt(selected.expires_at)}` : ''}</div>
                  </div>
                  {canDeleteVault && (
                    <button style={s.btnDanger} onClick={() => deleteVault(selected.id)}>삭제</button>
                  )}
                </div>
              </div>

              {/* Personal Vault 안내 */}
              {isPersonalVault && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 5, padding: '8px 12px', marginBottom: 12 }}>
                  🔒 이 Vault의 값은 이 PC의 OS 키체인(또는 로컬 암호화 파일)에만 저장됩니다. 서버에는 키 이름만 등록됩니다.
                </div>
              )}

              {/* Secrets */}
              <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>시크릿 ({secrets.length})</span>
                {canWrite && (
                  <button style={s.btn} onClick={() => setShowAddSecret(true)}>+ 시크릿 추가</button>
                )}
              </div>

              {secrets.length === 0 ? (
                <div style={{ ...s.card, textAlign: 'center', padding: '32px 20px' }}>
                  <div style={{ fontSize: 24, marginBottom: 8 }}>🗝️</div>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>시크릿이 없습니다</div>
                  {canWrite && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>+ 시크릿 추가로 환경변수를 저장하세요</div>}
                </div>
              ) : (
                secrets.map(sec => (
                  <div key={sec.id} style={s.secretRow}>
                    <span style={s.mono}>{sec.key_name}</span>
                    {isPersonalVault ? (
                      sec.revealed !== undefined ? (
                        <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--accent)', flex: 1, wordBreak: 'break-all' as const }}>{sec.revealed ?? '(로컬에 없음)'}</span>
                      ) : (
                        <button style={{ ...s.btnSm, fontSize: 11 }}
                          disabled={revealing === sec.id}
                          onClick={() => revealSecret(sec.id, sec.key_name)}>
                          {revealing === sec.id ? '...' : '값 보기'}
                        </button>
                      )
                    ) : (
                      <span style={{ fontFamily: 'monospace', fontSize: 13, color: 'var(--text-muted)', letterSpacing: 3 }}>••••••••</span>
                    )}
                    <span style={s.muted}>수정: {fmt(sec.updated_at)}</span>
                    {canWrite && (
                      <button style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}
                        onClick={() => deleteSecret(sec.id, sec.key_name)}
                        onMouseOver={e => e.currentTarget.style.color = 'var(--danger)'}
                        onMouseOut={e => e.currentTarget.style.color = 'var(--text-muted)'}
                        title="삭제">×</button>
                    )}
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>

      {/* Create Vault Modal */}
      {showCreateVault && (
        <div style={s.overlay} onClick={() => setShowCreateVault(false)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 700, borderBottom: '1px solid var(--border)', paddingBottom: 14 }}>새 Vault 생성</div>
            <div>
              <div style={s.label}>이름 *</div>
              <input style={s.input} value={newVault.name} onChange={e => setNewVault(v => ({ ...v, name: e.target.value }))}
                placeholder="예: 인스타그램 API 키" autoFocus />
            </div>
            <div>
              <div style={s.label}>스코프</div>
              <select style={{ ...s.input, cursor: 'pointer' }} value={newVault.scope} onChange={e => setNewVault(v => ({ ...v, scope: e.target.value }))}>
                <option value="personal_meta">개인 (personal) - 이 PC 전용</option>
                {(userRole === 'org_admin' || userRole === 'team_admin') && <>
                  <option value="org">조직 (org) - 전체 공유</option>
                  <option value="team">팀 (team) - 팀 전용</option>
                </>}
              </select>
            </div>
            <div>
              <div style={s.label}>설명</div>
              <input style={s.input} value={newVault.description} onChange={e => setNewVault(v => ({ ...v, description: e.target.value }))}
                placeholder="선택사항" />
            </div>
            {error && <div style={{ fontSize: 12, color: 'var(--danger)', padding: '6px 10px', background: 'var(--danger-dim)', borderRadius: 4 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="modal-btn-cancel" onClick={() => { setShowCreateVault(false); setError(''); }}>취소</button>
              <button className="modal-btn-ok" onClick={createVault} disabled={saving || !newVault.name.trim()}>
                {saving ? '생성 중...' : '생성'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Secret Modal */}
      {showAddSecret && (
        <div style={s.overlay} onClick={() => setShowAddSecret(false)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 700, borderBottom: '1px solid var(--border)', paddingBottom: 14 }}>🗝️ 시크릿 추가</div>
            {isPersonalVault ? (
              <div style={{ fontSize: 12, color: 'var(--accent)', background: 'var(--bg-elevated)', padding: '8px 12px', borderRadius: 4 }}>
                🔒 값은 이 PC의 OS 키체인에만 저장됩니다. 서버에는 키 이름만 등록됩니다.
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg-elevated)', padding: '8px 12px', borderRadius: 4 }}>
                ⚠️ 저장 후 값은 다시 조회할 수 없습니다 (Write-only)
              </div>
            )}
            <div>
              <div style={s.label}>키 이름 *</div>
              <input style={{ ...s.input, fontFamily: 'monospace' }} value={newSecret.key_name}
                onChange={e => setNewSecret(v => ({ ...v, key_name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') }))}
                placeholder="예: IG_ACCESS_TOKEN" autoFocus />
            </div>
            <div>
              <div style={s.label}>값 *</div>
              <input style={{ ...s.input, fontFamily: 'monospace' }} type="password" value={newSecret.value}
                onChange={e => setNewSecret(v => ({ ...v, value: e.target.value }))}
                placeholder="시크릿 값" />
            </div>
            {error && <div style={{ fontSize: 12, color: 'var(--danger)', padding: '6px 10px', background: 'var(--danger-dim)', borderRadius: 4 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="modal-btn-cancel" onClick={() => { setShowAddSecret(false); setError(''); }}>취소</button>
              <button className="modal-btn-ok" onClick={addSecret} disabled={saving || !newSecret.key_name.trim() || !newSecret.value.trim()}>
                {saving ? '저장 중...' : '저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
