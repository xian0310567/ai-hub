/**
 * Unit tests for api/openclaw/config/route.ts
 * 설정 조회/적용 API 엔드포인트 테스트
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const {
  mockGetSession,
  mockGetSetupStatus,
  mockWriteConfig,
  mockBuildDefaultConfig,
  mockCheckClaudeCli,
  mockStopGateway,
  mockStartGateway,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockGetSetupStatus: vi.fn(),
  mockWriteConfig: vi.fn(),
  mockBuildDefaultConfig: vi.fn(),
  mockCheckClaudeCli: vi.fn(),
  mockStopGateway: vi.fn(),
  mockStartGateway: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getSession: mockGetSession,
}));

vi.mock('@/lib/openclaw-config', () => ({
  getSetupStatus: mockGetSetupStatus,
  writeConfig: mockWriteConfig,
  buildDefaultConfig: mockBuildDefaultConfig,
  checkClaudeCli: mockCheckClaudeCli,
  SUPPORTED_MODELS: [
    { id: 'claude-cli/claude-sonnet-4-6', label: 'Sonnet 4.6', description: '권장', default: true },
    { id: 'claude-cli/claude-opus-4-6',   label: 'Opus 4.6',   description: '최고 성능' },
    { id: 'claude-cli/claude-haiku-4-5',  label: 'Haiku 4.5',  description: '빠른 응답' },
  ],
}));

vi.mock('@/lib/gateway-manager', () => ({
  stopGateway: mockStopGateway,
  startGateway: mockStartGateway,
}));

// ── Import after mocks ──────────────────────────────────────────────

import { GET, POST } from '../app/api/openclaw/config/route.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makeReq(method: string, body?: Record<string, unknown>): NextRequest {
  const url = 'http://localhost:3000/api/openclaw/config';
  if (method === 'GET') {
    return new NextRequest(url, { method });
  }
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

const MOCK_USER = { id: 'u1', username: 'test' };

const MOCK_STATUS = {
  configExists: false,
  configPath: '/home/test/.openclaw/openclaw.json',
  currentModel: null,
  claudeCli: { available: true, path: '/usr/local/bin/claude', version: '1.0.0' },
  isConfigured: false,
};

const MOCK_CONFIG = {
  gateway: { mode: 'local', port: 18789, bind: 'loopback', auth: { mode: 'none' } },
  agents: { defaults: { model: 'claude-cli/claude-sonnet-4-6' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

// ── GET /api/openclaw/config ────────────────────────────────────────

describe('GET /api/openclaw/config', () => {
  it('인증되지 않으면 401을 반환한다', async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await GET(makeReq('GET'));

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it('인증된 사용자에게 설정 상태와 모델 목록을 반환한다', async () => {
    mockGetSession.mockResolvedValue(MOCK_USER);
    mockGetSetupStatus.mockReturnValue(MOCK_STATUS);

    const res = await GET(makeReq('GET'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.status).toEqual(MOCK_STATUS);
    expect(data.supportedModels).toHaveLength(3);
  });
});

// ── POST /api/openclaw/config ───────────────────────────────────────

describe('POST /api/openclaw/config', () => {
  it('인증되지 않으면 401을 반환한다', async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await POST(makeReq('POST', { model: 'claude-cli/claude-sonnet-4-6' }));

    expect(res.status).toBe(401);
  });

  it('지원하지 않는 모델이면 400을 반환한다', async () => {
    mockGetSession.mockResolvedValue(MOCK_USER);

    const res = await POST(makeReq('POST', { model: 'invalid/model' }));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.error).toContain('지원하지 않는 모델');
  });

  it('Claude CLI가 없으면 400을 반환한다', async () => {
    mockGetSession.mockResolvedValue(MOCK_USER);
    mockCheckClaudeCli.mockReturnValue({
      available: false, path: null, version: null, error: 'not found',
    });

    const res = await POST(makeReq('POST', { model: 'claude-cli/claude-sonnet-4-6' }));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.error).toContain('Claude Code CLI');
  });

  it('유효한 요청이면 설정을 저장하고 게이트웨이를 재시작한다', async () => {
    mockGetSession.mockResolvedValue(MOCK_USER);
    mockCheckClaudeCli.mockReturnValue({
      available: true, path: '/usr/local/bin/claude', version: '1.0.0',
    });
    mockBuildDefaultConfig.mockReturnValue(MOCK_CONFIG);
    mockStartGateway.mockResolvedValue({ ok: true });

    const resPromise = POST(makeReq('POST', { model: 'claude-cli/claude-sonnet-4-6' }));

    // setTimeout(1000) 대기 진행
    await vi.advanceTimersByTimeAsync(1000);

    const res = await resPromise;
    const data = await res.json();

    expect(data.ok).toBe(true);
    expect(data.config.model).toBe('claude-cli/claude-sonnet-4-6');
    expect(data.gateway.restarted).toBe(true);
    expect(data.gateway.running).toBe(true);

    expect(mockWriteConfig).toHaveBeenCalledWith(MOCK_CONFIG);
    expect(mockStopGateway).toHaveBeenCalled();
    expect(mockStartGateway).toHaveBeenCalledWith(true);
  });

  it('모델을 지정하지 않으면 기본 모델로 설정한다', async () => {
    mockGetSession.mockResolvedValue(MOCK_USER);
    mockCheckClaudeCli.mockReturnValue({
      available: true, path: '/usr/local/bin/claude', version: '1.0.0',
    });
    mockBuildDefaultConfig.mockReturnValue(MOCK_CONFIG);
    mockStartGateway.mockResolvedValue({ ok: true });

    const resPromise = POST(makeReq('POST', {}));
    await vi.advanceTimersByTimeAsync(1000);
    const res = await resPromise;

    expect(res.status).toBe(200);
    // model이 falsy이면 유효성 검사를 건너뛰고 buildDefaultConfig에 전달
    expect(mockBuildDefaultConfig).toHaveBeenCalled();
  });

  it('게이트웨이 재시작에 실패해도 설정은 저장된 상태이며 결과를 반환한다', async () => {
    mockGetSession.mockResolvedValue(MOCK_USER);
    mockCheckClaudeCli.mockReturnValue({
      available: true, path: '/usr/local/bin/claude', version: '1.0.0',
    });
    mockBuildDefaultConfig.mockReturnValue(MOCK_CONFIG);
    mockStartGateway.mockResolvedValue({ ok: false, reason: 'startup_timeout' });

    const resPromise = POST(makeReq('POST', { model: 'claude-cli/claude-sonnet-4-6' }));
    await vi.advanceTimersByTimeAsync(1000);
    const res = await resPromise;
    const data = await res.json();

    expect(data.ok).toBe(true);
    expect(data.gateway.running).toBe(false);
    expect(data.gateway.reason).toBe('startup_timeout');
    expect(mockWriteConfig).toHaveBeenCalled();
  });
});
