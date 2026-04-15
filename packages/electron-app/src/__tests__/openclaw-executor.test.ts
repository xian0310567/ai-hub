/**
 * Unit tests for openclaw-executor.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks (vi.mock factories는 호이스팅되므로) ───────────────

const { mockExecFile, mockFindBinary, mockGatewayReady } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockFindBinary: vi.fn(),
  mockGatewayReady: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));
vi.mock('util', () => ({
  promisify: () => mockExecFile,
}));

vi.mock('../lib/gateway-manager.js', () => ({
  findOpenClawBinary: mockFindBinary,
}));

vi.mock('../lib/openclaw-client.js', () => ({
  isGatewayAvailable: vi.fn(),
  isGatewayReady: mockGatewayReady,
}));

vi.mock('../lib/claude-cli.js', () => ({
  CLAUDE_CLI: '/usr/local/bin/claude',
  CLAUDE_ENV: { PATH: '/usr/local/bin', HOME: '/home/test' },
}));

// ── Import after mocks ──────────────────────────────────────────────

import {
  cronAdd,
  cronList,
  cronRemove,
  agentRun,
  executeWithFallback,
} from '../lib/openclaw-executor.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── cronAdd ──────────────────────────────────────────────────────────

describe('cronAdd', () => {
  it('returns error when binary not found', async () => {
    mockFindBinary.mockReturnValue(null);
    const result = await cronAdd({ name: 'test', message: 'hello' });
    expect(result).toEqual({ ok: false, error: 'openclaw_not_found' });
  });

  it('calls CLI with correct args for cron schedule', async () => {
    mockFindBinary.mockReturnValue('/usr/local/bin/openclaw');
    mockExecFile.mockResolvedValueOnce({ stdout: '{"id":"job-123"}' });

    const result = await cronAdd({
      name: '뉴스 분석',
      cron: '0 1 * * *',
      tz: 'Asia/Seoul',
      message: '뉴스를 분석하세요',
      agent: 'agent-1',
      thinking: 'medium',
    });

    expect(result).toEqual({ ok: true, jobId: 'job-123' });
    expect(mockExecFile).toHaveBeenCalledWith(
      '/usr/local/bin/openclaw',
      ['cron', 'add', '--name', '뉴스 분석', '--json', '--cron', '0 1 * * *', '--tz', 'Asia/Seoul', '--message', '뉴스를 분석하세요', '--agent', 'agent-1', '--thinking', 'medium'],
      expect.objectContaining({ encoding: 'utf8', timeout: 30_000 }),
    );
  });

  it('calls CLI with --at for one-time schedule', async () => {
    mockFindBinary.mockReturnValue('/usr/local/bin/openclaw');
    mockExecFile.mockResolvedValueOnce({ stdout: '{"id":"job-456"}' });

    const result = await cronAdd({
      name: '1회 실행',
      at: '2026-04-13T01:00:00+09:00',
      message: '테스트',
    });

    expect(result.ok).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      '/usr/local/bin/openclaw',
      expect.arrayContaining(['--at', '2026-04-13T01:00:00+09:00']),
      expect.any(Object),
    );
  });

  it('returns error on CLI failure', async () => {
    mockFindBinary.mockReturnValue('/usr/local/bin/openclaw');
    mockExecFile.mockRejectedValueOnce(new Error('Command failed'));

    const result = await cronAdd({ name: 'fail', message: 'test' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Command failed');
  });
});

// ── cronList ─────────────────────────────────────────────────────────

describe('cronList', () => {
  it('returns empty array when binary not found', async () => {
    mockFindBinary.mockReturnValue(null);
    const result = await cronList();
    expect(result).toEqual([]);
  });

  it('returns parsed cron jobs', async () => {
    mockFindBinary.mockReturnValue('/usr/local/bin/openclaw');
    const jobs = [{ id: '1', name: 'job1', schedule: '0 9 * * *', enabled: true }];
    mockExecFile.mockResolvedValueOnce({ stdout: JSON.stringify(jobs) });

    const result = await cronList();
    expect(result).toEqual(jobs);
  });

  it('returns empty array on CLI failure', async () => {
    mockFindBinary.mockReturnValue('/usr/local/bin/openclaw');
    mockExecFile.mockRejectedValueOnce(new Error('fail'));

    const result = await cronList();
    expect(result).toEqual([]);
  });
});

// ── cronRemove ───────────────────────────────────────────────────────

describe('cronRemove', () => {
  it('returns error when binary not found', async () => {
    mockFindBinary.mockReturnValue(null);
    const result = await cronRemove('job-1');
    expect(result).toEqual({ ok: false, error: 'openclaw_not_found' });
  });

  it('removes cron job by id', async () => {
    mockFindBinary.mockReturnValue('/usr/local/bin/openclaw');
    mockExecFile.mockResolvedValueOnce({ stdout: '{}' });

    const result = await cronRemove('job-1');
    expect(result).toEqual({ ok: true });
    expect(mockExecFile).toHaveBeenCalledWith(
      '/usr/local/bin/openclaw',
      ['cron', 'remove', 'job-1', '--json'],
      expect.any(Object),
    );
  });
});

// ── agentRun ─────────────────────────────────────────────────────────

describe('agentRun', () => {
  it('uses Gateway HTTP API when available', async () => {
    mockGatewayReady.mockResolvedValue(true);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '분석 결과입니다.' } }] }),
    });

    const result = await agentRun({ message: '뉴스 분석해줘', agent: 'news-agent' });

    expect(result).toEqual({ ok: true, output: '분석 결과입니다.' });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/chat/completions'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"model":"openclaw/news-agent"'),
      }),
    );
  });

  it('falls back to CLI when Gateway unavailable', async () => {
    mockGatewayReady.mockResolvedValue(false);
    mockExecFile.mockResolvedValueOnce({ stdout: 'CLI 결과' });

    const result = await agentRun({ message: '테스트', timeout: 60 });

    expect(result).toEqual({ ok: true, output: 'CLI 결과' });
    expect(mockExecFile).toHaveBeenCalledWith(
      '/usr/local/bin/claude',
      ['-p', '테스트'],
      expect.objectContaining({ timeout: 70_000 }),
    );
  });

  it('falls back to CLI when Gateway request throws', async () => {
    mockGatewayReady.mockResolvedValue(true);
    mockFetch.mockRejectedValueOnce(new Error('Gateway timeout'));
    mockExecFile.mockResolvedValueOnce({ stdout: '폴백 결과' });

    const result = await agentRun({ message: '테스트' });
    expect(result).toEqual({ ok: true, output: '폴백 결과' });
  });

  it('falls back to CLI when Gateway returns 500', async () => {
    mockGatewayReady.mockResolvedValue(true);
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });
    mockExecFile.mockResolvedValueOnce({ stdout: 'CLI 폴백 결과' });

    const result = await agentRun({ message: '테스트' });
    expect(result).toEqual({ ok: true, output: 'CLI 폴백 결과' });
  });

  it('returns error when both Gateway and CLI fail', async () => {
    mockGatewayReady.mockResolvedValue(false);
    mockExecFile.mockRejectedValueOnce(new Error('Command failed'));

    const result = await agentRun({ message: '테스트' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Command failed');
  });
});

// ── executeWithFallback ──────────────────────────────────────────────

describe('executeWithFallback', () => {
  it('calls openclawFn when gateway available', async () => {
    mockGatewayReady.mockResolvedValue(true);
    const openclawFn = vi.fn().mockResolvedValue('openclaw-result');
    const fallbackFn = vi.fn().mockResolvedValue('fallback-result');

    const result = await executeWithFallback(openclawFn, fallbackFn, 'test');

    expect(result).toBe('openclaw-result');
    expect(openclawFn).toHaveBeenCalled();
    expect(fallbackFn).not.toHaveBeenCalled();
  });

  it('calls fallbackFn when gateway unavailable', async () => {
    mockGatewayReady.mockResolvedValue(false);
    const openclawFn = vi.fn();
    const fallbackFn = vi.fn().mockResolvedValue('fallback-result');

    const result = await executeWithFallback(openclawFn, fallbackFn, 'test');

    expect(result).toBe('fallback-result');
    expect(openclawFn).not.toHaveBeenCalled();
    expect(fallbackFn).toHaveBeenCalled();
  });

  it('falls back when openclawFn throws', async () => {
    mockGatewayReady.mockResolvedValue(true);
    const openclawFn = vi.fn().mockRejectedValue(new Error('openclaw error'));
    const fallbackFn = vi.fn().mockResolvedValue('fallback-result');

    const result = await executeWithFallback(openclawFn, fallbackFn, 'test');

    expect(result).toBe('fallback-result');
    expect(openclawFn).toHaveBeenCalled();
    expect(fallbackFn).toHaveBeenCalled();
  });
});
