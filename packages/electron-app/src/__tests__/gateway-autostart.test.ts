/**
 * Unit tests for Gateway auto-start feature
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks (vi.mock factories는 호이스팅되므로) ───────────────

const { mockStartGateway, mockSettings } = vi.hoisted(() => ({
  mockStartGateway: vi.fn(),
  mockSettings: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock('../lib/openclaw-client.js', () => ({
  isGatewayAvailable: vi.fn().mockResolvedValue(false),
}));

vi.mock('../lib/db.js', () => ({
  Settings: mockSettings,
}));

vi.mock('../lib/gateway-manager.js', () => ({
  startGateway: mockStartGateway,
  stopGateway: vi.fn(),
  getGatewayState: vi.fn().mockReturnValue('stopped'),
  getGatewayInfo: vi.fn().mockResolvedValue({
    state: 'stopped', pid: null, restartCount: 0, available: false, port: '18789',
  }),
  getRestartCount: vi.fn().mockReturnValue(0),
  initGatewayAutoStart: async () => {
    const autoStart = mockSettings.get('gateway_auto_start');
    if (autoStart === 'true') {
      await mockStartGateway();
    }
  },
}));

import { initGatewayAutoStart } from '../lib/gateway-manager.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Auto-start 설정 동작 ─────────────────────────────────────────────

describe('Gateway auto-start', () => {
  it('starts gateway when setting is true', async () => {
    mockSettings.get.mockReturnValue('true');
    mockStartGateway.mockResolvedValue({ ok: true });

    await initGatewayAutoStart();

    expect(mockStartGateway).toHaveBeenCalled();
  });

  it('does not start gateway when setting is false', async () => {
    mockSettings.get.mockReturnValue('false');

    await initGatewayAutoStart();

    expect(mockStartGateway).not.toHaveBeenCalled();
  });

  it('does not start gateway when setting is undefined', async () => {
    mockSettings.get.mockReturnValue(undefined);

    await initGatewayAutoStart();

    expect(mockStartGateway).not.toHaveBeenCalled();
  });

  it('does not start gateway when setting is null', async () => {
    mockSettings.get.mockReturnValue(null);

    await initGatewayAutoStart();

    expect(mockStartGateway).not.toHaveBeenCalled();
  });
});

// ── Settings 헬퍼 동작 ───────────────────────────────────────────────

describe('Settings helpers', () => {
  it('gets gateway_auto_start setting', () => {
    mockSettings.get.mockReturnValue('true');
    const val = mockSettings.get('gateway_auto_start');
    expect(val).toBe('true');
    expect(mockSettings.get).toHaveBeenCalledWith('gateway_auto_start');
  });

  it('sets gateway_auto_start setting', () => {
    mockSettings.set('gateway_auto_start', 'true');
    expect(mockSettings.set).toHaveBeenCalledWith('gateway_auto_start', 'true');
  });

  it('returns undefined for unset key', () => {
    mockSettings.get.mockReturnValue(undefined);
    const val = mockSettings.get('gateway_auto_start');
    expect(val).toBeUndefined();
  });
});
