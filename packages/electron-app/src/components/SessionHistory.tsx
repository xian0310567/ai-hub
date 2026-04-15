'use client';
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';

// ── Types ─────────────────────────────────────────────────────────────
interface ChatSession {
  agent_id: string;
  session_key: string | null;
  last_at: number;
  msg_count: number;
}

interface ChatMessage {
  id: string;
  role: string;
  content: string;
  created_at?: number;
}

interface AgentInfo {
  id: string;
  name: string;
  emoji?: string;
}

// ── Styles ────────────────────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 9000,
    background: 'rgba(8,8,12,0.55)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  panel: {
    width: 800,
    maxWidth: '92vw',
    maxHeight: '85vh',
    background: 'var(--bg-panel)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    boxShadow: '0 24px 80px rgba(0,0,0,.7)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '16px 20px',
    borderBottom: '1px solid var(--border)',
    background: 'linear-gradient(180deg, var(--bg-elevated) 0%, var(--bg-panel) 100%)',
    flexShrink: 0,
  },
  body: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  sidebar: {
    width: 260,
    borderRight: '1px solid var(--border)',
    overflowY: 'auto' as const,
    flexShrink: 0,
  },
  sessionItem: {
    padding: '10px 16px',
    borderBottom: '1px solid var(--border-subtle)',
    cursor: 'pointer',
    transition: 'background .1s',
  },
  messages: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '16px 20px',
  },
  msgBubble: {
    marginBottom: 12,
    padding: '10px 14px',
    borderRadius: 8,
    fontSize: 13,
    lineHeight: 1.7,
    maxWidth: '85%',
    wordBreak: 'break-word' as const,
    whiteSpace: 'pre-wrap' as const,
  },
  empty: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: 'var(--text-muted)',
    gap: 8,
  },
};

// ── Component ─────────────────────────────────────────────────────────
export default function SessionHistory({
  onClose,
  agents = [],
}: {
  onClose: () => void;
  agents?: AgentInfo[];
}) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selected, setSelected] = useState<{ agentId: string; sessionKey: string } | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const msgEndRef = useRef<HTMLDivElement>(null);

  const loadSessions = useCallback(async () => {
    try {
      const r = await fetch('/api/sessions');
      const d = await r.json();
      if (d.ok) setSessions(d.sessions ?? []);
    } catch {}
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const loadMessages = useCallback(async (agentId: string, sessionKey: string) => {
    setLoading(true);
    setSelected({ agentId, sessionKey });
    setMessages([]);  // 이전 메시지 즉시 클리어
    try {
      const r = await fetch(`/api/sessions?agent_id=${encodeURIComponent(agentId)}&session_key=${encodeURIComponent(sessionKey)}`);
      const d = await r.json();
      if (d.ok) setMessages(d.messages ?? []);
    } catch {}
    setLoading(false);
  }, []);

  // 메시지 로드 후 스크롤
  useEffect(() => {
    msgEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const agentMap = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);

  const getAgentName = (agentId: string) => {
    return agentMap.get(agentId)?.name ?? agentId.slice(0, 8);
  };

  const getAgentEmoji = (agentId: string) => {
    return agentMap.get(agentId)?.emoji ?? '🤖';
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    const now = new Date();
    const diff = Math.floor((now.getTime() - d.getTime()) / 1000);

    if (diff < 60) return '방금 전';
    if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}일 전`;
    return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
  };

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.panel} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={S.header}>
          <span style={{ fontSize: 15 }}>💬</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
            세션 히스토리
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {sessions.length}개 세션
          </span>
          <span
            style={{ marginLeft: 'auto', cursor: 'pointer', fontSize: 16, color: 'var(--text-muted)', lineHeight: 1, padding: '0 4px' }}
            onClick={onClose}
            onMouseOver={e => { (e.target as HTMLElement).style.color = 'var(--text-primary)'; }}
            onMouseOut={e => { (e.target as HTMLElement).style.color = 'var(--text-muted)'; }}
          >
            ✕
          </span>
        </div>

        <div style={S.body}>
          {/* Session List */}
          <div style={S.sidebar}>
            {sessions.length === 0 && (
              <div style={{ ...S.empty, padding: '32px 16px' }}>
                <span style={{ fontSize: 28, opacity: 0.3 }}>💬</span>
                <span style={{ fontSize: 12 }}>대화 기록이 없습니다</span>
              </div>
            )}
            {sessions.map((s, i) => {
              const isActive = selected?.agentId === s.agent_id && selected?.sessionKey === (s.session_key ?? s.agent_id);
              return (
                <div
                  key={`${s.agent_id}-${s.session_key ?? 'default'}-${i}`}
                  style={{
                    ...S.sessionItem,
                    background: isActive ? 'var(--bg-active)' : 'transparent',
                  }}
                  onClick={() => loadMessages(s.agent_id, s.session_key ?? s.agent_id)}
                  onMouseOver={e => {
                    if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-hover)';
                  }}
                  onMouseOut={e => {
                    if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 14 }}>{getAgentEmoji(s.agent_id)}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {getAgentName(s.agent_id)}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                      {formatTime(s.last_at)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 22 }}>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      {s.msg_count}개 메시지
                    </span>
                    {s.session_key && (
                      <span style={{
                        fontSize: 9,
                        fontWeight: 700,
                        padding: '1px 5px',
                        borderRadius: 6,
                        background: 'var(--accent-dim)',
                        color: 'var(--accent)',
                      }}>
                        GATEWAY
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Messages */}
          <div style={S.messages}>
            {!selected && (
              <div style={S.empty}>
                <span style={{ fontSize: 36, opacity: 0.2 }}>📝</span>
                <span style={{ fontSize: 13, fontWeight: 500 }}>세션을 선택하세요</span>
                <span style={{ fontSize: 11 }}>좌측 목록에서 대화 세션을 클릭하면</span>
                <span style={{ fontSize: 11 }}>메시지가 여기에 표시됩니다</span>
              </div>
            )}

            {selected && loading && (
              <div style={S.empty}>
                <div style={{
                  width: 28, height: 28, borderRadius: '50%',
                  border: '2px solid rgba(255,255,255,0.08)',
                  borderTopColor: 'var(--accent)',
                  animation: 'spin 0.65s linear infinite',
                }} />
                <span style={{ fontSize: 11 }}>로딩 중...</span>
              </div>
            )}

            {selected && !loading && messages.length === 0 && (
              <div style={S.empty}>
                <span style={{ fontSize: 28, opacity: 0.3 }}>📭</span>
                <span style={{ fontSize: 12 }}>메시지가 없습니다</span>
              </div>
            )}

            {selected && !loading && messages.map(m => (
              <div
                key={m.id}
                style={{
                  display: 'flex',
                  justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start',
                  marginBottom: 12,
                }}
              >
                <div style={{
                  ...S.msgBubble,
                  background: m.role === 'user' ? 'var(--accent-dim)' : 'var(--bg-elevated)',
                  border: m.role === 'user' ? '1px solid #0d99ff33' : '1px solid var(--border)',
                  color: 'var(--text-primary)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: m.role === 'user' ? 'var(--accent)' : 'var(--text-muted)', textTransform: 'uppercase' }}>
                      {m.role === 'user' ? 'You' : m.role === 'assistant' ? getAgentName(selected.agentId) : 'System'}
                    </span>
                    {m.created_at && (
                      <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                        {new Date(m.created_at * 1000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                  {m.content}
                </div>
              </div>
            ))}
            <div ref={msgEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
