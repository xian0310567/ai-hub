'use client';
import { useEffect, useState, useCallback, useRef } from 'react';

// ── Types ─────────────────────────────────────────────────────────────
interface GatewayInfo {
  state: 'stopped' | 'starting' | 'running' | 'error';
  pid: number | null;
  restartCount: number;
  available: boolean;
  port: string;
  lastError: string | null;
  needsBuild: boolean;
}

interface DbStatus {
  ok: boolean;
  hasSyncedConfig: boolean;
  configVersion: number;
  runtimeDir: string | null;
  totalAgents: number;
}

interface StatusData {
  ok: boolean;
  gateway: { available: boolean; url: string; ready?: boolean };
  db: DbStatus | null;
}

// ── 에러 메시지 한국어 매핑 ───────────────────────────────────────────
const ERROR_MESSAGES: Record<string, string> = {
  openclaw_not_found: 'openclaw CLI를 찾을 수 없습니다.',
  openclaw_not_built: 'OpenClaw 패키지를 빌드해야 합니다.',
  startup_timeout: '게이트웨이 시작 시간이 초과되었습니다 (10초).',
  already_starting: '이미 시작 중입니다.',
  process_error: '게이트웨이 프로세스 오류가 발생했습니다.',
};

function getErrorMessage(reason: string | null | undefined): string {
  if (!reason) return '알 수 없는 오류';
  return ERROR_MESSAGES[reason] ?? reason;
}

// ── Styles ────────────────────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  wrapper: {
    position: 'fixed',
    bottom: 16,
    right: 16,
    zIndex: 5000,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 8,
  },
  pill: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 14px',
    background: 'var(--bg-panel)',
    border: '1px solid var(--border)',
    borderRadius: 20,
    cursor: 'pointer',
    transition: 'all .15s',
    fontFamily: "'Inter', -apple-system, sans-serif",
    userSelect: 'none',
  },
  panel: {
    width: 320,
    background: 'var(--bg-panel)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    boxShadow: '0 12px 40px rgba(0,0,0,.5)',
    overflow: 'hidden',
  },
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '14px 16px 12px',
    borderBottom: '1px solid var(--border)',
    background: 'linear-gradient(180deg, var(--bg-elevated) 0%, var(--bg-panel) 100%)',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 16px',
    borderBottom: '1px solid var(--border-subtle)',
    fontSize: 12,
  },
  label: {
    flex: 1,
    color: 'var(--text-secondary)',
    fontWeight: 500,
  },
  badge: {
    display: 'inline-block',
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: 10,
    textTransform: 'uppercase' as const,
  },
  btnGroup: {
    display: 'flex',
    gap: 8,
    padding: '12px 16px',
  },
  btn: {
    flex: 1,
    fontSize: 11,
    fontWeight: 600,
    padding: '6px 0',
    borderRadius: 4,
    border: 'none',
    cursor: 'pointer',
    fontFamily: "'Inter', -apple-system, sans-serif",
    transition: 'opacity .15s',
  },
  errorBox: {
    margin: '0 16px',
    padding: '8px 10px',
    background: 'rgba(239, 68, 68, 0.08)',
    border: '1px solid rgba(239, 68, 68, 0.2)',
    borderRadius: 6,
    fontSize: 11,
    color: '#ef4444',
    lineHeight: 1.4,
  },
  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 16px',
    borderBottom: '1px solid var(--border-subtle)',
    fontSize: 12,
  },
  toggle: {
    position: 'relative' as const,
    width: 36,
    height: 20,
    borderRadius: 10,
    cursor: 'pointer',
    transition: 'background .2s',
    flexShrink: 0,
    border: 'none',
    padding: 0,
  },
  toggleKnob: {
    position: 'absolute' as const,
    top: 2,
    width: 16,
    height: 16,
    borderRadius: '50%',
    background: '#fff',
    transition: 'left .2s',
    boxShadow: '0 1px 3px rgba(0,0,0,.3)',
  },
};

const GATEWAY_STATUS: Record<string, { label: string; color: string }> = {
  running:  { label: '실행중', color: 'var(--success)' },
  starting: { label: '시작중', color: '#f59e0b' },
  stopped:  { label: '중지됨', color: 'var(--text-muted)' },
  error:    { label: '오류',   color: 'var(--danger)' },
};

// ── Component ─────────────────────────────────────────────────────────
export default function OpenClawStatus() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [gatewayInfo, setGatewayInfo] = useState<GatewayInfo | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [autoStart, setAutoStart] = useState(false);
  const [autoStartLoading, setAutoStartLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    const [statusResult, gwResult] = await Promise.allSettled([
      fetch('/api/openclaw/status').then(r => r.ok ? r.json() : null),
      fetch('/api/openclaw/gateway').then(r => r.ok ? r.json() : null),
    ]);
    if (statusResult.status === 'fulfilled' && statusResult.value) setStatus(statusResult.value);
    if (gwResult.status === 'fulfilled' && gwResult.value) setGatewayInfo(gwResult.value);
  }, []);

  // 자동 시작 설정 로드
  const loadAutoStart = useCallback(async () => {
    try {
      const res = await fetch('/api/settings?key=gateway_auto_start');
      if (res.ok) {
        const data = await res.json();
        setAutoStart(data.value === 'true');
      }
    } catch {}
  }, []);

  // 초기 로드 + 폴링
  useEffect(() => {
    reload();
    loadAutoStart();
    pollRef.current = setInterval(reload, 10_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [reload, loadAutoStart]);

  // 패널 외부 클릭 시 닫기
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const gwState = gatewayInfo?.state ?? 'stopped';
  const gwAvailable = gatewayInfo?.available ?? status?.gateway?.available ?? false;
  const effectiveState = gwAvailable ? 'running' : gwState;
  const gwColor = GATEWAY_STATUS[effectiveState]?.color ?? 'var(--text-muted)';
  const gwLabel = GATEWAY_STATUS[effectiveState]?.label ?? effectiveState;

  const handleGatewayAction = async (action: 'start' | 'stop') => {
    setActionLoading(true);
    try {
      await fetch('/api/openclaw/gateway', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      // 잠시 후 상태 갱신
      setTimeout(reload, 1500);
    } catch {}
    setActionLoading(false);
  };

  const handleSync = async () => {
    setSyncLoading(true);
    try {
      await fetch('/api/openclaw/sync', { method: 'POST' });
      setTimeout(reload, 1000);
    } catch {}
    setSyncLoading(false);
  };

  const handleAutoStartToggle = async () => {
    const newValue = !autoStart;
    setAutoStartLoading(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'gateway_auto_start', value: newValue ? 'true' : 'false' }),
      });
      if (res.ok) setAutoStart(newValue);
    } catch {}
    setAutoStartLoading(false);
  };

  const agentCount = status?.db?.totalAgents ?? 0;
  const synced = status?.db?.hasSyncedConfig ?? false;
  const configVer = status?.db?.configVersion ?? 0;
  const lastError = gatewayInfo?.lastError;
  const showError = effectiveState === 'error' && lastError;

  return (
    <div style={S.wrapper} ref={panelRef}>
      {/* 확장 패널 */}
      {open && (
        <div style={S.panel}>
          <div style={S.panelHeader}>
            <span style={{ fontSize: 14 }}>OpenClaw</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>시스템 상태</span>
            <span
              style={{ marginLeft: 'auto', cursor: 'pointer', fontSize: 14, color: 'var(--text-muted)', lineHeight: 1 }}
              onClick={() => setOpen(false)}
            >
              ✕
            </span>
          </div>

          {/* Gateway */}
          <div style={S.row}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: gwColor, flexShrink: 0 }} />
            <span style={S.label}>Gateway</span>
            <span style={{ ...S.badge, background: `${gwColor}22`, color: gwColor }}>{gwLabel}</span>
          </div>

          {/* 에러 상세 */}
          {showError && (
            <div style={{ padding: '0 0 8px' }}>
              <div style={S.errorBox}>
                <div>{getErrorMessage(lastError)}</div>
                {(lastError === 'openclaw_not_built' || gatewayInfo?.needsBuild) && (
                  <div style={{ marginTop: 4, fontSize: 10, opacity: 0.85 }}>
                    터미널에서 실행: <code style={{ background: 'rgba(255,255,255,.1)', padding: '1px 4px', borderRadius: 3 }}>pnpm --filter openclaw build</code>
                  </div>
                )}
              </div>
            </div>
          )}

          {gwAvailable && gatewayInfo && (
            <div style={{ ...S.row, fontSize: 11, color: 'var(--text-muted)' }}>
              <span style={S.label}>PID / Port</span>
              <span>{gatewayInfo.pid ?? '-'} / :{gatewayInfo.port}</span>
            </div>
          )}

          {gatewayInfo && gatewayInfo.restartCount > 0 && (
            <div style={{ ...S.row, fontSize: 11, color: '#f59e0b' }}>
              <span style={S.label}>재시작 횟수</span>
              <span>{gatewayInfo.restartCount}</span>
            </div>
          )}

          {/* DB Sync */}
          <div style={S.row}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: synced ? 'var(--success)' : 'var(--text-muted)', flexShrink: 0 }} />
            <span style={S.label}>설정 동기화</span>
            <span style={{ ...S.badge, background: synced ? 'var(--success)22' : '#61616122', color: synced ? 'var(--success)' : 'var(--text-muted)' }}>
              {synced ? `v${configVer}` : '미동기화'}
            </span>
          </div>

          {/* Agent Count */}
          <div style={S.row}>
            <span style={S.label}>등록 에이전트</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: agentCount > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              {agentCount}
            </span>
          </div>

          {/* Ready Status */}
          {status?.gateway?.ready !== undefined && (
            <div style={S.row}>
              <span style={S.label}>Gateway Ready</span>
              <span style={{ ...S.badge, background: status.gateway.ready ? 'var(--success)22' : '#f59e0b22', color: status.gateway.ready ? 'var(--success)' : '#f59e0b' }}>
                {status.gateway.ready ? 'READY' : 'NOT READY'}
              </span>
            </div>
          )}

          {/* Auto Start Toggle */}
          <div style={S.toggleRow}>
            <span style={S.label}>서버 시작 시 자동 실행</span>
            <button
              style={{
                ...S.toggle,
                background: autoStart ? 'var(--accent)' : 'var(--bg-canvas)',
                border: autoStart ? 'none' : '1px solid var(--border)',
                opacity: autoStartLoading ? 0.5 : 1,
              }}
              disabled={autoStartLoading}
              onClick={handleAutoStartToggle}
              aria-label="자동 시작 토글"
            >
              <span style={{ ...S.toggleKnob, left: autoStart ? 18 : 2 }} />
            </button>
          </div>

          {/* Actions */}
          <div style={S.btnGroup}>
            {!gwAvailable ? (
              <button
                style={{ ...S.btn, background: 'var(--accent)', color: '#fff', opacity: actionLoading ? 0.5 : 1 }}
                disabled={actionLoading}
                onClick={() => handleGatewayAction('start')}
              >
                {actionLoading ? '시작 중...' : 'Gateway 시작'}
              </button>
            ) : (
              <button
                style={{ ...S.btn, background: 'var(--bg-canvas)', color: 'var(--danger)', border: '1px solid var(--danger)', opacity: actionLoading ? 0.5 : 1 }}
                disabled={actionLoading}
                onClick={() => handleGatewayAction('stop')}
              >
                {actionLoading ? '중지 중...' : 'Gateway 중지'}
              </button>
            )}
            <button
              style={{ ...S.btn, background: 'var(--bg-canvas)', color: 'var(--text-secondary)', border: '1px solid var(--border)', opacity: syncLoading ? 0.5 : 1 }}
              disabled={syncLoading}
              onClick={handleSync}
            >
              {syncLoading ? '동기화 중...' : '설정 동기화'}
            </button>
          </div>
        </div>
      )}

      {/* 접힌 상태 알약 */}
      <div
        style={S.pill}
        onClick={() => setOpen(v => !v)}
        onMouseOver={e => { (e.currentTarget as HTMLDivElement).style.borderColor = '#555'; }}
        onMouseOut={e => { (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)'; }}
      >
        <span style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: gwColor,
          boxShadow: gwAvailable ? `0 0 6px ${gwColor}` : 'none',
        }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>
          OpenClaw
        </span>
        <span style={{ fontSize: 10, fontWeight: 700, color: gwColor }}>
          {gwLabel}
        </span>
        {agentCount > 0 && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {agentCount}agents
          </span>
        )}
      </div>
    </div>
  );
}
