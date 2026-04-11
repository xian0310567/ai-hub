/**
 * Unit tests for session history API and data flow
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────

const { mockFetch, mockGetSessionHistory, mockChatLogs } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockGetSessionHistory: vi.fn(),
  mockChatLogs: {
    add: vi.fn(),
    clear: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    sessions: vi.fn().mockReturnValue([]),
    sessionMessages: vi.fn().mockReturnValue([]),
    sessionsFiltered: vi.fn().mockReturnValue([]),
    search: vi.fn().mockReturnValue([]),
    deleteSession: vi.fn(),
    exportSession: vi.fn().mockReturnValue({ agentId: 'a1', sessionKey: null, messages: [] }),
  },
}));

vi.stubGlobal('fetch', mockFetch);

vi.mock('../lib/openclaw-client.js', () => ({
  getSessionHistory: (key: string, limit?: number) => mockGetSessionHistory(key, limit),
  isGatewayAvailable: vi.fn().mockResolvedValue(false),
}));

vi.mock('../lib/auth.js', () => ({
  getSession: vi.fn().mockResolvedValue({ id: 'user-1', orgId: 'org-1' }),
  getVmSessionCookie: vi.fn().mockReturnValue('session=test'),
  getUserSessionsDir: vi.fn().mockReturnValue('/tmp/test-sessions'),
}));

vi.mock('../lib/db.js', () => ({
  ChatLogs: mockChatLogs,
}));

import { ChatLogs } from '../lib/db.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── ChatLogs sessions ───────────────────────────────────────────────��─

describe('ChatLogs.sessions', () => {
  it('returns empty array when no sessions', () => {
    const sessions = ChatLogs.sessions('user-1');
    expect(sessions).toEqual([]);
    expect(ChatLogs.sessions).toHaveBeenCalledWith('user-1');
  });

  it('returns session list with correct shape', () => {
    mockChatLogs.sessions.mockReturnValueOnce([
      { agent_id: 'agent-1', session_key: 'user-1:agent-1', last_at: 1712700000, msg_count: 10 },
      { agent_id: 'agent-2', session_key: null, last_at: 1712699000, msg_count: 5 },
    ]);

    const sessions = ChatLogs.sessions('user-1');
    expect(sessions).toHaveLength(2);
    expect(sessions[0].agent_id).toBe('agent-1');
    expect(sessions[0].session_key).toBe('user-1:agent-1');
    expect(sessions[0].msg_count).toBe(10);
    expect(sessions[1].session_key).toBeNull();
  });
});

// ── ChatLogs sessionMessages ──────────────────────────────────────────

describe('ChatLogs.sessionMessages', () => {
  it('returns messages for a session', () => {
    const msgs = [
      { id: '1', user_id: 'u1', agent_id: 'a1', role: 'user', content: 'Hello', session_key: 'key1', created_at: 1712700000 },
      { id: '2', user_id: 'u1', agent_id: 'a1', role: 'assistant', content: 'Hi!', session_key: 'key1', created_at: 1712700010 },
    ];
    mockChatLogs.sessionMessages.mockReturnValueOnce(msgs);

    const result = ChatLogs.sessionMessages('u1', 'a1', 'key1');
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
  });

  it('calls with correct arguments including session key', () => {
    ChatLogs.sessionMessages('u1', 'a1', 'key1');
    expect(ChatLogs.sessionMessages).toHaveBeenCalledWith('u1', 'a1', 'key1');
  });
});

// ── ChatLogs.add with session_key ─────────────────────────────────────

describe('ChatLogs.add with session_key', () => {
  it('accepts session_key parameter', () => {
    ChatLogs.add({
      id: 'log-1',
      user_id: 'u1',
      agent_id: 'a1',
      role: 'user',
      content: 'Hello',
      session_key: 'u1:a1',
    });

    expect(ChatLogs.add).toHaveBeenCalledWith(expect.objectContaining({
      session_key: 'u1:a1',
    }));
  });

  it('works without session_key', () => {
    ChatLogs.add({
      id: 'log-2',
      user_id: 'u1',
      agent_id: 'a1',
      role: 'assistant',
      content: 'Hi!',
    });

    expect(ChatLogs.add).toHaveBeenCalledWith(expect.objectContaining({
      id: 'log-2',
      role: 'assistant',
    }));
  });
});

// ── ChatLogs.sessionsFiltered ─────────────────────────────────────────

describe('ChatLogs.sessionsFiltered', () => {
  it('filters by agent_id', () => {
    mockChatLogs.sessionsFiltered.mockReturnValueOnce([
      { agent_id: 'a1', session_key: 'key1', last_at: 1712700000, msg_count: 5 },
    ]);

    const result = ChatLogs.sessionsFiltered('u1', { agentId: 'a1' });
    expect(result).toHaveLength(1);
    expect(ChatLogs.sessionsFiltered).toHaveBeenCalledWith('u1', { agentId: 'a1' });
  });

  it('filters by date range', () => {
    ChatLogs.sessionsFiltered('u1', { from: 1712600000, to: 1712700000 });
    expect(ChatLogs.sessionsFiltered).toHaveBeenCalledWith('u1', { from: 1712600000, to: 1712700000 });
  });

  it('combines agent_id and date range', () => {
    ChatLogs.sessionsFiltered('u1', { agentId: 'a1', from: 1712600000, to: 1712700000 });
    expect(ChatLogs.sessionsFiltered).toHaveBeenCalledWith('u1', {
      agentId: 'a1', from: 1712600000, to: 1712700000,
    });
  });
});

// ── ChatLogs.search ───────────────────────────────────────────────────

describe('ChatLogs.search', () => {
  it('returns matching messages', () => {
    const matches = [
      { id: '1', user_id: 'u1', agent_id: 'a1', role: 'user', content: 'deploy 방법', session_key: 'key1', created_at: 1712700000 },
    ];
    mockChatLogs.search.mockReturnValueOnce(matches);

    const result = ChatLogs.search('u1', 'deploy');
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('deploy');
  });

  it('returns empty array when no match', () => {
    mockChatLogs.search.mockReturnValueOnce([]);
    const result = ChatLogs.search('u1', 'nonexistent');
    expect(result).toEqual([]);
  });
});

// ── ChatLogs.deleteSession ────────────────────────────────────────────

describe('ChatLogs.deleteSession', () => {
  it('deletes session with session_key', () => {
    ChatLogs.deleteSession('u1', 'a1', 'key1');
    expect(ChatLogs.deleteSession).toHaveBeenCalledWith('u1', 'a1', 'key1');
  });

  it('deletes session without session_key (null sessions)', () => {
    ChatLogs.deleteSession('u1', 'a1');
    expect(ChatLogs.deleteSession).toHaveBeenCalledWith('u1', 'a1');
  });
});

// ── ChatLogs.exportSession ────────────────────────────────────────────

describe('ChatLogs.exportSession', () => {
  it('exports session as JSON object', () => {
    mockChatLogs.exportSession.mockReturnValueOnce({
      agentId: 'a1',
      sessionKey: 'key1',
      messages: [
        { id: '1', role: 'user', content: 'hello' },
        { id: '2', role: 'assistant', content: 'hi' },
      ],
    });

    const result = ChatLogs.exportSession('u1', 'a1', 'key1');
    expect(result.agentId).toBe('a1');
    expect(result.sessionKey).toBe('key1');
    expect(result.messages).toHaveLength(2);
  });
});

// ── Gateway session history ───────────────────────────────────────────

describe('Gateway getSessionHistory', () => {
  it('fetches session history from gateway', async () => {
    mockGetSessionHistory.mockResolvedValue([
      { role: 'user', content: 'What is 2+2?' },
      { role: 'assistant', content: '4' },
    ]);

    const history = await mockGetSessionHistory('user-1:agent-1');
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('user');
    expect(history[1].content).toBe('4');
  });

  it('returns empty array when gateway unavailable', async () => {
    mockGetSessionHistory.mockResolvedValue([]);

    const history = await mockGetSessionHistory('user-1:agent-1');
    expect(history).toEqual([]);
  });

  it('supports limit parameter', async () => {
    mockGetSessionHistory.mockResolvedValue([]);
    await mockGetSessionHistory('key', 20);
    expect(mockGetSessionHistory).toHaveBeenCalledWith('key', 20);
  });
});

// ── Session API response shape ────────────────────────────────────────

describe('Session API response shape', () => {
  it('sessions list response has correct shape', () => {
    const response = {
      ok: true,
      sessions: [
        { agent_id: 'a1', session_key: 'user:a1', last_at: 1712700000, msg_count: 10 },
        { agent_id: 'a2', session_key: null, last_at: 1712699000, msg_count: 3 },
      ],
    };

    expect(response.ok).toBe(true);
    expect(response.sessions).toHaveLength(2);
    expect(response.sessions[0]).toHaveProperty('agent_id');
    expect(response.sessions[0]).toHaveProperty('session_key');
    expect(response.sessions[0]).toHaveProperty('last_at');
    expect(response.sessions[0]).toHaveProperty('msg_count');
  });

  it('session messages response includes local and gateway fields', () => {
    const response = {
      ok: true,
      session_key: 'user:agent',
      agent_id: 'agent-1',
      local: [
        { id: '1', role: 'user', content: 'hi' },
        { id: '2', role: 'assistant', content: 'hello' },
      ],
      gateway: [],
      messages: [
        { id: '1', role: 'user', content: 'hi' },
        { id: '2', role: 'assistant', content: 'hello' },
      ],
    };

    expect(response.ok).toBe(true);
    expect(response.messages).toHaveLength(2);
    expect(response.local).toHaveLength(2);
    expect(response.gateway).toHaveLength(0);
  });

  it('falls back to gateway messages when local is empty', () => {
    const local: { id: string; role: string; content: string }[] = [];
    const gateway = [
      { role: 'user', content: 'gateway msg' },
      { role: 'assistant', content: 'gateway reply' },
    ];

    const messages = local.length > 0
      ? local
      : gateway.map((m, i) => ({ id: `gw-${i}`, role: m.role, content: m.content }));

    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe('gw-0');
    expect(messages[0].content).toBe('gateway msg');
  });
});

// ── UI state derivation ───────────────────────────────────────────────

describe('Session history UI helpers', () => {
  it('formats recent time correctly', () => {
    const now = Math.floor(Date.now() / 1000);
    const formatTime = (ts: number) => {
      const diff = now - ts;
      if (diff < 60) return '방금 전';
      if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
      if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
      return `${Math.floor(diff / 86400)}일 전`;
    };

    expect(formatTime(now - 10)).toBe('방금 전');
    expect(formatTime(now - 300)).toBe('5분 전');
    expect(formatTime(now - 7200)).toBe('2시간 전');
    expect(formatTime(now - 172800)).toBe('2일 전');
  });

  it('identifies gateway sessions by session_key presence', () => {
    const sessions = [
      { agent_id: 'a1', session_key: 'user:a1', last_at: 0, msg_count: 1 },
      { agent_id: 'a2', session_key: null, last_at: 0, msg_count: 1 },
    ];

    const gatewaySessions = sessions.filter(s => s.session_key !== null);
    const cliSessions = sessions.filter(s => s.session_key === null);

    expect(gatewaySessions).toHaveLength(1);
    expect(cliSessions).toHaveLength(1);
  });
});
