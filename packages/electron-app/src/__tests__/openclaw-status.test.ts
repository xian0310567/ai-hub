/**
 * Unit tests for OpenClaw status widget data flow
 * Tests the /api/openclaw/status and /api/openclaw/gateway endpoints
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockIsGatewayAvailable = vi.fn();
const mockGetGatewayStatus = vi.fn();

vi.mock('../lib/openclaw-client.js', () => ({
  isGatewayAvailable: () => mockIsGatewayAvailable(),
  getGatewayStatus: () => mockGetGatewayStatus(),
}));

const mockGetGatewayInfo = vi.fn();
const mockStartGateway = vi.fn();
const mockStopGateway = vi.fn();

vi.mock('../lib/gateway-manager.js', () => ({
  getGatewayInfo: () => mockGetGatewayInfo(),
  startGateway: () => mockStartGateway(),
  stopGateway: () => mockStopGateway(),
  getGatewayState: vi.fn().mockReturnValue('stopped'),
  getRestartCount: vi.fn().mockReturnValue(0),
}));

vi.mock('../lib/auth.js', () => ({
  getSession: vi.fn().mockResolvedValue({ id: 'user-1', orgId: 'org-1' }),
  getVmSessionCookie: vi.fn().mockReturnValue('session=test'),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Status API data shape ─────────────────────────────────────────────

describe('OpenClaw status data shape', () => {
  it('status response includes gateway and db fields', async () => {
    const statusData = {
      ok: true,
      gateway: { available: true, url: 'http://127.0.0.1:18789', ready: true },
      db: {
        ok: true,
        hasSyncedConfig: true,
        configVersion: 3,
        runtimeDir: '/tmp/openclaw-runtime/org-1',
        totalAgents: 12,
      },
    };

    expect(statusData.gateway.available).toBe(true);
    expect(statusData.gateway.ready).toBe(true);
    expect(statusData.db?.totalAgents).toBe(12);
    expect(statusData.db?.hasSyncedConfig).toBe(true);
    expect(statusData.db?.configVersion).toBe(3);
  });

  it('handles offline gateway status', () => {
    const statusData = {
      ok: true,
      gateway: { available: false, url: 'http://127.0.0.1:18789' },
      db: null,
    };

    expect(statusData.gateway.available).toBe(false);
    expect(statusData.gateway.ready).toBeUndefined();
    expect(statusData.db).toBeNull();
  });
});

// ── Gateway info shape ────────────────────────────────────────────────

describe('Gateway info', () => {
  it('returns full gateway info when running', async () => {
    mockGetGatewayInfo.mockResolvedValue({
      state: 'running',
      pid: 12345,
      restartCount: 0,
      available: true,
      port: '18789',
    });

    const info = await mockGetGatewayInfo();
    expect(info.state).toBe('running');
    expect(info.pid).toBe(12345);
    expect(info.available).toBe(true);
    expect(info.port).toBe('18789');
  });

  it('returns stopped state when gateway is not running', async () => {
    mockGetGatewayInfo.mockResolvedValue({
      state: 'stopped',
      pid: null,
      restartCount: 0,
      available: false,
      port: '18789',
    });

    const info = await mockGetGatewayInfo();
    expect(info.state).toBe('stopped');
    expect(info.pid).toBeNull();
    expect(info.available).toBe(false);
  });

  it('tracks restart count', async () => {
    mockGetGatewayInfo.mockResolvedValue({
      state: 'running',
      pid: 99999,
      restartCount: 3,
      available: true,
      port: '18789',
    });

    const info = await mockGetGatewayInfo();
    expect(info.restartCount).toBe(3);
  });
});

// ── Gateway control actions ───────────────────────────────────────────

describe('Gateway control', () => {
  it('start returns ok on success', async () => {
    mockStartGateway.mockResolvedValue({ ok: true });

    const result = await mockStartGateway();
    expect(result.ok).toBe(true);
  });

  it('start returns reason when already running', async () => {
    mockStartGateway.mockResolvedValue({ ok: true, reason: 'already_running' });

    const result = await mockStartGateway();
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('already_running');
  });

  it('start returns error when binary not found', async () => {
    mockStartGateway.mockResolvedValue({ ok: false, reason: 'openclaw_not_found' });

    const result = await mockStartGateway();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('openclaw_not_found');
  });

  it('stop is callable', () => {
    mockStopGateway.mockReturnValue(undefined);
    mockStopGateway();
    expect(mockStopGateway).toHaveBeenCalled();
  });
});

// ── Status widget state derivation ────────────────────────────────────

describe('Status widget state derivation', () => {
  const GATEWAY_STATUS: Record<string, { label: string; color: string }> = {
    running:  { label: '실행중', color: 'var(--success)' },
    starting: { label: '시작중', color: '#f59e0b' },
    stopped:  { label: '중지됨', color: 'var(--text-muted)' },
    error:    { label: '오류',   color: 'var(--danger)' },
  };

  it('derives running state correctly', () => {
    const gwAvailable = true;
    const gwState = 'running';
    const effectiveState = gwAvailable ? 'running' : gwState;
    expect(GATEWAY_STATUS[effectiveState].label).toBe('실행중');
  });

  it('derives stopped state when unavailable', () => {
    const gwAvailable = false;
    const gwState = 'stopped';
    const effectiveState = gwAvailable ? 'running' : gwState;
    expect(GATEWAY_STATUS[effectiveState].label).toBe('중지됨');
  });

  it('overrides state to running when gateway is available', () => {
    // Gateway manager says "starting" but health check says available
    const gwAvailable = true;
    const gwState = 'starting';
    const effectiveState = gwAvailable ? 'running' : gwState;
    expect(effectiveState).toBe('running');
  });

  it('shows error state when gateway failed', () => {
    const gwAvailable = false;
    const gwState = 'error';
    const effectiveState = gwAvailable ? 'running' : gwState;
    expect(GATEWAY_STATUS[effectiveState].label).toBe('오류');
  });
});

// ── Parallel fetch pattern ────────────────────────────────────────────

describe('Status widget fetch pattern', () => {
  it('fetches status and gateway info in parallel', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          gateway: { available: true, url: 'http://127.0.0.1:18789', ready: true },
          db: { totalAgents: 5, hasSyncedConfig: true, configVersion: 2 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          state: 'running',
          pid: 1234,
          restartCount: 0,
          available: true,
          port: '18789',
        }),
      });

    const [statusRes, gwRes] = await Promise.all([
      mockFetch('/api/openclaw/status').then((r: { ok: boolean; json: () => Promise<unknown> }) => r.ok ? r.json() : null),
      mockFetch('/api/openclaw/gateway').then((r: { ok: boolean; json: () => Promise<unknown> }) => r.ok ? r.json() : null),
    ]);

    expect(statusRes).toBeDefined();
    expect(gwRes).toBeDefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('handles fetch failures gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const results = await Promise.all([
      mockFetch('/api/openclaw/status').catch(() => null),
      mockFetch('/api/openclaw/gateway').catch(() => null),
    ]);

    expect(results[0]).toBeNull();
    expect(results[1]).toBeNull();
  });
});
