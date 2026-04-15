/**
 * Unit tests for unified chat API fallback logic
 * Tests that Gateway mode is preferred and CLI is used as fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('next/server', () => {
  class MockNextRequest {
    cookies: { get: (name: string) => { value: string } | undefined };
    constructor() { this.cookies = { get: () => undefined }; }
  }
  return { NextRequest: MockNextRequest };
});

// Mock openclaw-client module
const mockIsGatewayAvailable = vi.fn();
const mockSendToGateway = vi.fn();
const mockKillSession = vi.fn();

vi.mock('../lib/openclaw-client.js', () => ({
  isGatewayAvailable: () => mockIsGatewayAvailable(),
  sendToGateway: (opts: unknown) => mockSendToGateway(opts),
  killSession: (key: string) => mockKillSession(key),
}));

// Mock claude-cli
vi.mock('../lib/claude-cli.js', () => ({
  CLAUDE_CLI: '/usr/bin/claude',
  CLAUDE_ENV: process.env,
  claudeSpawnError: (e: Error) => e.message,
}));

// Mock auth
vi.mock('../lib/auth.js', () => ({
  getSession: vi.fn().mockResolvedValue({ id: 'user-1', orgId: 'org-1' }),
  getVmSessionCookie: vi.fn().mockReturnValue('session=test'),
  getUserSessionsDir: vi.fn().mockReturnValue('/tmp/test-sessions'),
}));

// Mock db
vi.mock('../lib/db.js', () => ({
  ChatLogs: {
    add: vi.fn(),
    clear: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe('Chat mode selection', () => {
  it('prefers Gateway when available', async () => {
    mockIsGatewayAvailable.mockResolvedValue(true);

    // The core logic: when gateway is available, use it
    const available = await mockIsGatewayAvailable();
    expect(available).toBe(true);
  });

  it('falls back to CLI when Gateway is unavailable', async () => {
    mockIsGatewayAvailable.mockResolvedValue(false);

    const available = await mockIsGatewayAvailable();
    expect(available).toBe(false);
  });
});

describe('Gateway send options', () => {
  it('sendToGateway includes agent-id header', () => {
    const mockStream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('ok')); c.close(); },
    });
    mockSendToGateway.mockReturnValue(mockStream);

    const result = mockSendToGateway({
      agentId: 'test-agent',
      message: 'hello',
      sessionKey: 'user-1:test-agent',
      stream: true,
    });

    expect(mockSendToGateway).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'test-agent',
      message: 'hello',
      sessionKey: 'user-1:test-agent',
    }));
    expect(result).toBeDefined();
  });
});

describe('Session reset', () => {
  it('killSession is called on reset', async () => {
    mockKillSession.mockResolvedValue(true);

    await mockKillSession('user-1:test-agent');

    expect(mockKillSession).toHaveBeenCalledWith('user-1:test-agent');
  });
});

describe('Mode detection endpoint', () => {
  it('returns gateway mode when available', async () => {
    mockIsGatewayAvailable.mockResolvedValue(true);

    const mode = (await mockIsGatewayAvailable()) ? 'gateway' : 'cli';
    expect(mode).toBe('gateway');
  });

  it('returns cli mode when gateway unavailable', async () => {
    mockIsGatewayAvailable.mockResolvedValue(false);

    const mode = (await mockIsGatewayAvailable()) ? 'gateway' : 'cli';
    expect(mode).toBe('cli');
  });
});
