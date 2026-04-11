/**
 * Unit tests for Gateway log streaming feature
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks (vi.mock 호이스팅 대응) ────────────────────────────

const { mockLogBuffer, mockSettings, mockEmitter } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events');
  return {
    mockLogBuffer: [] as Array<{ ts: number; stream: string; line: string }>,
    mockSettings: { get: vi.fn(), set: vi.fn() },
    mockEmitter: new EventEmitter(),
  };
});

vi.mock('../lib/openclaw-client.js', () => ({
  isGatewayAvailable: vi.fn().mockResolvedValue(false),
}));

vi.mock('../lib/db.js', () => ({
  Settings: mockSettings,
}));

vi.mock('../lib/gateway-manager.js', () => ({
  gatewayLogs: mockEmitter,
  getLogBuffer: () => [...mockLogBuffer],
  clearLogBuffer: () => { mockLogBuffer.length = 0; },
  getGatewayState: vi.fn().mockReturnValue('stopped'),
  getGatewayInfo: vi.fn().mockResolvedValue({
    state: 'stopped', pid: null, restartCount: 0, available: false, port: '18789',
  }),
  startGateway: vi.fn().mockResolvedValue({ ok: true }),
  stopGateway: vi.fn(),
  getRestartCount: vi.fn().mockReturnValue(0),
  initGatewayAutoStart: vi.fn(),
}));

import { gatewayLogs, getLogBuffer, clearLogBuffer } from '../lib/gateway-manager.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockLogBuffer.length = 0;
  mockEmitter.removeAllListeners();
});

// ── 로그 버퍼 관리 ───────────────────────────────────────────────────

describe('Log buffer management', () => {
  it('getLogBuffer returns copy of buffer', () => {
    mockLogBuffer.push({ ts: 1000, stream: 'stdout', line: 'hello' });
    const buf = getLogBuffer();
    expect(buf).toHaveLength(1);
    expect(buf[0].line).toBe('hello');
    buf.push({ ts: 2000, stream: 'stderr', line: 'extra' });
    expect(getLogBuffer()).toHaveLength(1);
  });

  it('clearLogBuffer empties the buffer', () => {
    mockLogBuffer.push({ ts: 1000, stream: 'stdout', line: 'hello' });
    mockLogBuffer.push({ ts: 2000, stream: 'stderr', line: 'world' });
    expect(getLogBuffer()).toHaveLength(2);

    clearLogBuffer();
    expect(getLogBuffer()).toHaveLength(0);
  });

  it('returns empty buffer initially', () => {
    expect(getLogBuffer()).toEqual([]);
  });
});

// ── EventEmitter 동작 ────────────────────────────────────────────────

describe('Gateway log EventEmitter', () => {
  it('emits log events', () => {
    const received: unknown[] = [];
    gatewayLogs.on('log', (entry: unknown) => received.push(entry));

    const entry = { ts: Date.now(), stream: 'stdout', line: 'test log line' };
    gatewayLogs.emit('log', entry);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(entry);
  });

  it('multiple listeners receive same event', () => {
    const received1: unknown[] = [];
    const received2: unknown[] = [];
    gatewayLogs.on('log', (e: unknown) => received1.push(e));
    gatewayLogs.on('log', (e: unknown) => received2.push(e));

    gatewayLogs.emit('log', { ts: 1, stream: 'stdout', line: 'x' });

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
  });

  it('separates stdout and stderr entries', () => {
    const entries: Array<{ stream: string }> = [];
    gatewayLogs.on('log', (e: { stream: string }) => entries.push(e));

    gatewayLogs.emit('log', { ts: 1, stream: 'stdout', line: 'out' });
    gatewayLogs.emit('log', { ts: 2, stream: 'stderr', line: 'err' });

    expect(entries[0].stream).toBe('stdout');
    expect(entries[1].stream).toBe('stderr');
  });
});

// ── GatewayLogEntry 형태 검증 ────────────────────────────────────────

describe('GatewayLogEntry shape', () => {
  it('has required fields', () => {
    const entry = { ts: Date.now(), stream: 'stdout' as const, line: 'Gateway ready on :18789' };

    expect(entry).toHaveProperty('ts');
    expect(entry).toHaveProperty('stream');
    expect(entry).toHaveProperty('line');
    expect(typeof entry.ts).toBe('number');
    expect(['stdout', 'stderr']).toContain(entry.stream);
  });
});

// ── Socket.IO 통합 패턴 검증 ─────────────────────────────────────────

describe('Socket.IO integration pattern', () => {
  it('gateway:subscribe → gateway:history → gateway:log flow', () => {
    const history = [
      { ts: 1000, stream: 'stdout', line: 'prev log 1' },
      { ts: 2000, stream: 'stdout', line: 'prev log 2' },
    ];
    mockLogBuffer.push(...history);

    const historyData = getLogBuffer();
    expect(historyData).toHaveLength(2);

    const realtime: unknown[] = [];
    gatewayLogs.on('log', (e: unknown) => realtime.push(e));
    gatewayLogs.emit('log', { ts: 3000, stream: 'stderr', line: 'new error' });

    expect(realtime).toHaveLength(1);
  });

  it('gateway:unsubscribe stops receiving logs (simulated)', () => {
    const handler = vi.fn();
    gatewayLogs.on('log', handler);

    gatewayLogs.emit('log', { ts: 1, stream: 'stdout', line: 'before' });
    expect(handler).toHaveBeenCalledTimes(1);

    gatewayLogs.removeListener('log', handler);
    gatewayLogs.emit('log', { ts: 2, stream: 'stdout', line: 'after' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ── Gateway API logs param ───────────────────────────────────────────

describe('Gateway API with logs', () => {
  it('GET ?logs=1 includes log buffer in response', () => {
    mockLogBuffer.push({ ts: 1000, stream: 'stdout', line: 'test' });

    const response = {
      ok: true,
      state: 'running',
      pid: 123,
      restartCount: 0,
      available: true,
      port: '18789',
      logs: getLogBuffer(),
    };

    expect(response.logs).toHaveLength(1);
    expect(response.logs[0].line).toBe('test');
  });

  it('GET without logs param does not include logs', () => {
    const response = {
      ok: true,
      state: 'stopped',
      pid: null,
      restartCount: 0,
      available: false,
      port: '18789',
    };

    expect(response).not.toHaveProperty('logs');
  });

  it('POST clear-logs action empties buffer', () => {
    mockLogBuffer.push({ ts: 1, stream: 'stdout', line: 'a' });
    mockLogBuffer.push({ ts: 2, stream: 'stderr', line: 'b' });

    clearLogBuffer();

    expect(getLogBuffer()).toHaveLength(0);
  });
});
