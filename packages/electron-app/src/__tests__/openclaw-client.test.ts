/**
 * Unit tests for openclaw-client.ts and gateway-manager.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock fetch ────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Import after mocks ───────────────────────────────────────────────

import {
  isGatewayAvailable,
  getGatewayStatus,
  sendToGateway,
} from '../lib/openclaw-client.js';

import {
  getGatewayState,
  getRestartCount,
} from '../lib/gateway-manager.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── isGatewayAvailable ───────────────────────────────────────────────

describe('isGatewayAvailable', () => {
  it('returns true when gateway responds ok', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const result = await isGatewayAvailable();
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/health'),
      expect.any(Object),
    );
  });

  it('returns false when gateway is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await isGatewayAvailable();
    expect(result).toBe(false);
  });

  it('returns true when gateway returns non-ok (server is reachable)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const result = await isGatewayAvailable();
    expect(result).toBe(true);
  });

  it('returns true when gateway returns 500 (server is running despite plugin error)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const result = await isGatewayAvailable();
    expect(result).toBe(true);
  });
});

// ── getGatewayStatus ─────────────────────────────────────────────────

describe('getGatewayStatus', () => {
  it('returns available=false when health check fails', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const status = await getGatewayStatus();
    expect(status.available).toBe(false);
    expect(status.url).toBeDefined();
  });

  it('returns ready=true when both health and ready pass', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    const status = await getGatewayStatus();
    expect(status.available).toBe(true);
    expect(status.ready).toBe(true);
  });
});

// ── sendToGateway ────────────────────────────────────────────────────

describe('sendToGateway', () => {
  it('sends request to /v1/chat/completions with correct headers', async () => {
    // Mock non-streaming response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: null,
      json: async () => ({
        choices: [{ message: { content: 'Hello!' } }],
      }),
    });

    const stream = sendToGateway({
      agentId: 'test-agent',
      message: 'Hello',
      sessionKey: 'session-1',
      stream: false,
    });

    const reader = stream.getReader();
    const chunks: string[] = [];
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    expect(chunks.join('')).toBe('Hello!');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/chat/completions'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-openclaw-agent-id': 'test-agent',
          'x-openclaw-session-key': 'session-1',
        }),
      }),
    );
  });

  it('handles gateway error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
      statusText: 'Service Unavailable',
    });

    const stream = sendToGateway({
      agentId: 'test-agent',
      message: 'Hello',
      stream: false,
    });

    const reader = stream.getReader();
    const chunks: string[] = [];
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    expect(chunks.join('')).toContain('Gateway 오류 503');
  });

  it('handles network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const stream = sendToGateway({
      agentId: 'test-agent',
      message: 'Hello',
      stream: false,
    });

    const reader = stream.getReader();
    const chunks: string[] = [];
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    expect(chunks.join('')).toContain('Gateway 연결 오류');
  });
});

// ── Gateway Manager state ────────────────────────────────────────────

describe('GatewayManager', () => {
  it('initial state is stopped', () => {
    expect(getGatewayState()).toBe('stopped');
  });

  it('restart count starts at 0', () => {
    expect(getRestartCount()).toBe(0);
  });
});
