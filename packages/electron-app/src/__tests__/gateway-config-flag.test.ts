/**
 * Unit tests for gateway-manager.ts 변경사항
 * --allow-unconfigured 조건부 적용 및 환경변수 정리 검증
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ───────────────────────────────────────────────────

const { mockReadConfig, mockSpawn, mockIsGatewayAvailable } = vi.hoisted(() => {
  const createMockProcess = () => {
    const stdout = { on: vi.fn() };
    const stderr = { on: vi.fn() };
    return {
      pid: 12345,
      stdout,
      stderr,
      on: vi.fn(),
      kill: vi.fn(),
    };
  };

  return {
    mockReadConfig: vi.fn(),
    mockSpawn: vi.fn(() => createMockProcess()),
    mockIsGatewayAvailable: vi.fn(),
  };
});

vi.mock('../lib/openclaw-config.js', () => ({
  readConfig: mockReadConfig,
}));

vi.mock('../lib/openclaw-client.js', () => ({
  isGatewayAvailable: mockIsGatewayAvailable,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: mockSpawn,
    execSync: vi.fn().mockReturnValue('/usr/local/bin/openclaw'),
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
  };
});

vi.mock('../lib/db.js', () => ({
  Settings: { get: vi.fn(), set: vi.fn() },
}));

// ── Import after mocks ──────────────────────────────────────────────

import { startGateway, stopGateway } from '../lib/gateway-manager.js';

/** startGateway 내부의 await isGatewayAvailable()이 해소된 뒤 spawn이 호출되도록 대기 */
const flushAsync = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  stopGateway();
  // 게이트웨이가 아직 실행되지 않은 상태
  mockIsGatewayAvailable.mockResolvedValue(false);
});

afterEach(() => {
  stopGateway();
});

// ── --allow-unconfigured 조건부 적용 ────────────────────────────────

describe('--allow-unconfigured 조건부 플래그', () => {
  it('openclaw.json이 없으면 --allow-unconfigured를 포함한다', async () => {
    mockReadConfig.mockReturnValue(null);

    // startGateway는 내부에서 await가 있으므로 spawn은 비동기로 호출됨
    startGateway(true);
    await flushAsync();

    expect(mockSpawn).toHaveBeenCalled();
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('--allow-unconfigured');
  });

  it('openclaw.json이 있으면 --allow-unconfigured를 포함하지 않는다', async () => {
    mockReadConfig.mockReturnValue({
      gateway: { mode: 'local', port: 18789, bind: 'loopback', auth: { mode: 'none' } },
      agents: { defaults: { model: 'claude-cli/claude-sonnet-4-6' } },
    });

    startGateway(true);
    await flushAsync();

    expect(mockSpawn).toHaveBeenCalled();
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--allow-unconfigured');
  });

  it('항상 --bind, --port, --force를 포함한다', async () => {
    mockReadConfig.mockReturnValue(null);

    startGateway(true);
    await flushAsync();

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('--bind');
    expect(spawnArgs).toContain('--port');
    expect(spawnArgs).toContain('--force');
  });
});

// ── 환경변수 정리 ───────────────────────────────────────────────────

describe('spawn 환경변수', () => {
  it('ANTHROPIC_API_KEY를 환경변수에 포함하지 않는다', async () => {
    mockReadConfig.mockReturnValue(null);
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';

    startGateway(true);
    await flushAsync();

    expect(mockSpawn).toHaveBeenCalled();
    const spawnOpts = mockSpawn.mock.calls[0][2] as { env: Record<string, string | undefined> };
    expect(spawnOpts.env).not.toHaveProperty('ANTHROPIC_API_KEY');

    delete process.env.ANTHROPIC_API_KEY;
  });

  it('PATH와 HOME을 환경변수에 포함한다', async () => {
    mockReadConfig.mockReturnValue(null);

    startGateway(true);
    await flushAsync();

    const spawnOpts = mockSpawn.mock.calls[0][2] as { env: Record<string, string | undefined> };
    expect(spawnOpts.env).toHaveProperty('PATH');
    expect(spawnOpts.env).toHaveProperty('HOME');
  });
});
