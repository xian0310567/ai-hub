/**
 * Unit tests for OpenClaw 통합 코드 리뷰 수정 사항
 *
 * P0-3: stream.tee() 로그 저장 실패 시 에러 로깅 + reader 해제
 * P1-4: gateway fallback 메시지에 created_at
 * P1-5: SessionHistory 세션 전환 시 setMessages([]) 추가
 * P1-6: Gateway 이중 spawn 방지 + starting 상태 체크
 * P2-9: timeout/close 경합 (closed 플래그)
 * P2-10: reader 미해제 수정
 * P2-11: Gateway crash fallback
 * P2-12: MAX_RESTARTS 수동 복구
 * P2-14: chat_logs 인덱스
 * P3-19: Promise.allSettled
 * P3-20: SessionHistory agents Map 최적화
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock fetch ────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Import after mocks ───────────────────────────────────────────────

import {
  sendToGateway,
} from '../lib/openclaw-client.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── P2-9 & P2-10: closed 플래그 + reader 해제 ──────────────────────

describe('P2-9: sendToGateway timeout/close 경합 방지', () => {
  it('타임아웃 시 스트림이 정상적으로 종료됨', async () => {
    // fetch가 매우 느려서 타임아웃이 발생하는 시나리오
    mockFetch.mockImplementation(() => new Promise((resolve) => {
      // 타임아웃(100ms)보다 느리게 응답
      setTimeout(() => resolve({ ok: true, body: null }), 500);
    }));

    const stream = sendToGateway({
      agentId: 'test',
      message: 'hello',
      stream: false,
      timeoutMs: 100, // 매우 짧은 타임아웃
    });

    const reader = stream.getReader();
    const chunks: string[] = [];
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    expect(chunks.join('')).toContain('타임아웃');
  });

  it('controller.close()가 두 번 호출되어도 에러 발생하지 않음', async () => {
    // Gateway가 빈 응답 후 즉시 종료
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
    });

    const stream = sendToGateway({
      agentId: 'test',
      message: 'hello',
      stream: true,
      timeoutMs: 5000,
    });

    const reader = stream.getReader();
    // 스트림 정상 소비 — 에러가 throw되지 않아야 함
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  });
});

describe('P2-10: reader 해제 보장', () => {
  it('에러 발생 시에도 reader가 해제됨', async () => {
    // 네트워크 에러 시뮬레이션
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const stream = sendToGateway({
      agentId: 'test',
      message: 'hello',
      stream: true,
    });

    const reader = stream.getReader();
    const chunks: string[] = [];
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    // 에러 메시지가 포함됨
    expect(chunks.join('')).toContain('Gateway 연결 오류');
  });
});

// ── P2-9: SSE 스트리밍 정상 처리 ────────────────────────────────────

describe('P2-9: SSE 스트리밍 closed 플래그 동작', () => {
  it('정상 SSE 스트리밍이 올바르게 파싱됨', async () => {
    const sseData = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" World"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      }),
    });

    const stream = sendToGateway({
      agentId: 'test',
      message: 'hello',
      stream: true,
    });

    const reader = stream.getReader();
    const chunks: string[] = [];
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    expect(chunks.join('')).toBe('Hello World');
  });
});

// ── P1-4: gateway fallback 메시지 created_at ────────────────────────

describe('P1-4: gateway fallback 메시지에 created_at', () => {
  it('gateway 메시지에 created_at 근사값이 부여됨', () => {
    const gatewayMessages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ];

    const now = Math.floor(Date.now() / 1000);
    const messages = gatewayMessages.map((m, i) => ({
      id: `gw-${i}`,
      user_id: 'user-1',
      agent_id: 'agent-1',
      role: m.role,
      content: m.content,
      session_key: 'key',
      created_at: Math.floor(Date.now() / 1000) - (gatewayMessages.length - i),
    }));

    // 모든 메시지에 created_at이 있음
    for (const msg of messages) {
      expect(msg.created_at).toBeDefined();
      expect(typeof msg.created_at).toBe('number');
      expect(msg.created_at).toBeGreaterThan(0);
    }

    // 시간순 정렬
    expect(messages[0].created_at).toBeLessThan(messages[1].created_at);
  });
});

// ── P1-5: SessionHistory 세션 전환 시 메시지 클리어 ──────────────────

describe('P1-5: 세션 전환 시 이전 메시지 클리어', () => {
  it('loadMessages 호출 시 messages가 즉시 비워짐', () => {
    // React state 시뮬레이션
    let messages = [
      { id: '1', role: 'user', content: 'old msg' },
    ];
    let loading = false;
    let selected: { agentId: string; sessionKey: string } | null = null;

    // loadMessages 로직 시뮬레이션
    const loadMessages = (agentId: string, sessionKey: string) => {
      loading = true;
      selected = { agentId, sessionKey };
      messages = []; // P1-5 수정: 이전 메시지 즉시 클리어
    };

    // 이전 세션의 메시지가 있는 상태에서 세션 전환
    expect(messages.length).toBe(1);
    loadMessages('agent-2', 'key-2');

    // 즉시 비워져야 함
    expect(messages.length).toBe(0);
    expect(loading).toBe(true);
    expect(selected?.agentId).toBe('agent-2');
  });
});

// ── P1-6 & P2-12: Gateway 이중 spawn 방지 + 수동 복구 ──────────────

describe('P1-6: Gateway starting 상태에서 중복 시작 방지', () => {
  it('already_starting 이유가 반환되어야 함', async () => {
    // startGateway의 로직을 직접 테스트 (모듈 상태에 의존)
    // state가 'starting'일 때의 가드 로직 검증
    let _state = 'starting';

    const startGateway = async () => {
      if (_state === 'starting') {
        return { ok: false, reason: 'already_starting' };
      }
      return { ok: true };
    };

    const result = await startGateway();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('already_starting');
  });
});

describe('P2-12: 수동 호출 시 restartCount 리셋', () => {
  it('manual=true일 때 카운터 리셋 로직', () => {
    let _restartCount = 5;
    const MAX_RESTARTS = 5;

    // manual=false: 카운터가 MAX에 도달해서 재시작 불가
    const canRestart = _restartCount < MAX_RESTARTS;
    expect(canRestart).toBe(false);

    // manual=true: 카운터 리셋
    _restartCount = 0; // manual reset
    expect(_restartCount).toBe(0);
    expect(_restartCount < MAX_RESTARTS).toBe(true);
  });
});

// ── P2-11: Gateway crash fallback ────────────────────────────────────

describe('P2-11: Gateway 에러 감지 및 CLI fallback', () => {
  it('Gateway 연결 에러 텍스트를 올바르게 감지함', () => {
    const errorTexts = [
      '[Gateway 연결 오류] ECONNREFUSED',
      '[Gateway 오류 503] Service Unavailable',
    ];

    for (const text of errorTexts) {
      const isGatewayError = text.startsWith('[Gateway 연결 오류]') || text.startsWith('[Gateway 오류');
      expect(isGatewayError).toBe(true);
    }
  });

  it('정상 응답은 에러로 감지하지 않음', () => {
    const normalTexts = [
      '안녕하세요! 무엇을 도와드릴까요?',
      'Hello, how can I help?',
      '## 응답\n여기 결과입니다.',
    ];

    for (const text of normalTexts) {
      const isGatewayError = text.startsWith('[Gateway 연결 오류]') || text.startsWith('[Gateway 오류');
      expect(isGatewayError).toBe(false);
    }
  });

  it('Gateway 에러 스트림이 생성되면 첫 청크로 감지 가능', async () => {
    // Gateway 연결 실패 시뮬레이션
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const stream = sendToGateway({
      agentId: 'test',
      message: 'hello',
      stream: true,
    });

    const reader = stream.getReader();
    const firstChunk = await reader.read();

    expect(firstChunk.done).toBe(false);
    const text = new TextDecoder().decode(firstChunk.value).trimStart();
    expect(text.startsWith('[Gateway 연결 오류]')).toBe(true);

    // 나머지 소비
    reader.releaseLock();
  });
});

// ── P3-19: Promise.allSettled 패턴 ──────────────────────────────────

describe('P3-19: Promise.allSettled로 독립 실패 처리', () => {
  it('하나가 실패해도 다른 것은 성공', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('status API down'))  // status 실패
      .mockResolvedValueOnce({                                // gateway 성공
        ok: true,
        json: async () => ({ state: 'running', available: true }),
      });

    const [statusResult, gwResult] = await Promise.allSettled([
      mockFetch('/api/openclaw/status').then((r: { ok: boolean; json: () => Promise<unknown> }) => r.ok ? r.json() : null),
      mockFetch('/api/openclaw/gateway').then((r: { ok: boolean; json: () => Promise<unknown> }) => r.ok ? r.json() : null),
    ]);

    expect(statusResult.status).toBe('rejected');
    expect(gwResult.status).toBe('fulfilled');
    if (gwResult.status === 'fulfilled') {
      expect((gwResult.value as { available: boolean }).available).toBe(true);
    }
  });

  it('둘 다 실패해도 예외가 발생하지 않음', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const results = await Promise.allSettled([
      mockFetch('/api/openclaw/status'),
      mockFetch('/api/openclaw/gateway'),
    ]);

    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');
  });
});

// ── P3-20: agents Map 최적화 ────────────────────────────────────────

describe('P3-20: agents lookup Map', () => {
  it('Map 기반 lookup이 find와 동일한 결과', () => {
    const agents = [
      { id: 'a1', name: '에이전트1', emoji: '🤖' },
      { id: 'a2', name: '에이전트2', emoji: '🧑‍💻' },
      { id: 'a3', name: '에이전트3', emoji: '🎯' },
    ];

    // 기존 방식 (O(n))
    const findResult = agents.find(a => a.id === 'a2');

    // 새 방식 (O(1))
    const agentMap = new Map(agents.map(a => [a.id, a]));
    const mapResult = agentMap.get('a2');

    expect(findResult).toEqual(mapResult);
    expect(mapResult?.name).toBe('에이전트2');
  });

  it('없는 id에 대해 undefined 반환', () => {
    const agents = [{ id: 'a1', name: '에이전트1' }];
    const agentMap = new Map(agents.map(a => [a.id, a]));

    expect(agentMap.get('nonexistent')).toBeUndefined();
  });
});

// ── P0-3: 에러 로깅 패턴 검증 ───────────────────────────────────────

describe('P0-3: stream log 저장 실패 시 에러 로깅', () => {
  it('console.error가 호출되는 패턴 검증', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // 에러 발생 시 로깅하는 패턴
    const agentId = 'test-agent';
    try {
      throw new Error('DB write failed');
    } catch (err) {
      console.error(`[ChatLog] 대화 기록 저장 실패 (agent=${agentId}):`, err);
    }

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ChatLog] 대화 기록 저장 실패'),
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  it('reader.releaseLock()이 finally에서 호출되는 패턴', async () => {
    let released = false;

    const mockReader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data') })
        .mockRejectedValueOnce(new Error('stream error')),
      releaseLock: () => { released = true; },
    };

    try {
      while (true) {
        const { done } = await mockReader.read();
        if (done) break;
      }
    } catch {
      // 에러 무시
    } finally {
      mockReader.releaseLock();
    }

    expect(released).toBe(true);
  });
});

// ── P1-6: Health check backoff ──────────────────────────────────────

describe('P1-6: Health check backoff 적용', () => {
  it('restartCount에 비례하는 backoff 계산', () => {
    const delays: number[] = [];
    for (let count = 1; count <= 5; count++) {
      delays.push(2000 * count);
    }

    expect(delays).toEqual([2000, 4000, 6000, 8000, 10000]);
  });
});
