/**
 * Unit tests for openclaw-config.ts
 * 설정 파일 읽기/쓰기, CLI 확인, 상태 조회 모듈 테스트
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ───────────────────────────────────────────────────

const { mockExistsSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync, mockExecSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockExecSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
}));

vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));

// ── Import after mocks ──────────────────────────────────────────────

import {
  readConfig,
  writeConfig,
  buildDefaultConfig,
  checkClaudeCli,
  getSetupStatus,
  SUPPORTED_MODELS,
  DEFAULT_MODEL,
} from '../lib/openclaw-config.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 상수 검증 ───────────────────────────────────────────────────────

describe('SUPPORTED_MODELS', () => {
  it('3개의 모델을 포함한다', () => {
    expect(SUPPORTED_MODELS).toHaveLength(3);
  });

  it('모든 모델 id가 claude-cli/ 접두사를 가진다', () => {
    for (const m of SUPPORTED_MODELS) {
      expect(m.id).toMatch(/^claude-cli\//);
    }
  });

  it('기본 모델이 정확히 1개 존재한다', () => {
    const defaults = SUPPORTED_MODELS.filter(m => m.default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(DEFAULT_MODEL);
  });
});

// ── readConfig ──────────────────────────────────────────────────────

describe('readConfig', () => {
  it('openclaw.json이 없으면 null을 반환한다', () => {
    mockExistsSync.mockReturnValue(false);

    const result = readConfig();

    expect(result).toBeNull();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('유효한 설정 파일이면 파싱된 객체를 반환한다', () => {
    const config = {
      gateway: { mode: 'local', port: 18789, bind: 'loopback', auth: { mode: 'none' } },
      agents: { defaults: { model: 'claude-cli/claude-sonnet-4-6' } },
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(config));

    const result = readConfig();

    expect(result).toEqual(config);
    expect(mockReadFileSync).toHaveBeenCalledWith(expect.stringContaining('openclaw.json'), 'utf-8');
  });

  it('잘못된 JSON이면 null을 반환한다', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{ invalid json !!!');

    const result = readConfig();

    expect(result).toBeNull();
  });

  it('파일 읽기 에러 시 null을 반환한다', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => { throw new Error('EACCES'); });

    const result = readConfig();

    expect(result).toBeNull();
  });
});

// ── writeConfig ─────────────────────────────────────────────────────

describe('writeConfig', () => {
  it('디렉토리를 생성하고 설정 파일을 쓴다', () => {
    const config = buildDefaultConfig();

    writeConfig(config);

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('.openclaw'),
      { recursive: true },
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('openclaw.json'),
      JSON.stringify(config, null, 2),
      'utf-8',
    );
  });
});

// ── buildDefaultConfig ──────────────────────────────────────────────

describe('buildDefaultConfig', () => {
  it('모델을 지정하지 않으면 기본 모델을 사용한다', () => {
    const config = buildDefaultConfig();

    expect(config.agents.defaults.model).toBe(DEFAULT_MODEL);
  });

  it('지정한 모델을 사용한다', () => {
    const config = buildDefaultConfig('claude-cli/claude-opus-4-6');

    expect(config.agents.defaults.model).toBe('claude-cli/claude-opus-4-6');
  });

  it('gateway 기본값이 올바르게 설정된다', () => {
    const config = buildDefaultConfig();

    expect(config.gateway.mode).toBe('local');
    expect(config.gateway.port).toBe(18789);
    expect(config.gateway.bind).toBe('loopback');
    expect(config.gateway.auth.mode).toBe('none');
  });

  it('claudePath가 "claude"이면 cliBackends를 설정하지 않는다', () => {
    const config = buildDefaultConfig(undefined, 'claude');

    expect(config.agents.defaults.cliBackends).toBeUndefined();
  });

  it('claudePath가 커스텀 경로이면 cliBackends에 command를 설정한다', () => {
    const config = buildDefaultConfig(undefined, '/usr/local/bin/claude');

    expect(config.agents.defaults.cliBackends).toEqual({
      'claude-cli': { command: '/usr/local/bin/claude' },
    });
  });

  it('claudePath가 없으면 cliBackends를 설정하지 않는다', () => {
    const config = buildDefaultConfig('claude-cli/claude-sonnet-4-6');

    expect(config.agents.defaults.cliBackends).toBeUndefined();
  });
});

// ── checkClaudeCli ──────────────────────────────────────────────────

describe('checkClaudeCli', () => {
  it('claude가 PATH에 있으면 available: true를 반환한다', () => {
    mockExecSync
      .mockReturnValueOnce('/usr/local/bin/claude')   // which claude
      .mockReturnValueOnce('1.2.3');                   // claude --version

    const result = checkClaudeCli();

    expect(result.available).toBe(true);
    expect(result.path).toBe('/usr/local/bin/claude');
    expect(result.version).toBe('1.2.3');
    expect(result.error).toBeUndefined();
  });

  it('claude가 PATH에 있지만 --version이 실패해도 available: true를 반환한다', () => {
    mockExecSync
      .mockReturnValueOnce('/usr/local/bin/claude')
      .mockImplementationOnce(() => { throw new Error('version failed'); });

    const result = checkClaudeCli();

    expect(result.available).toBe(true);
    expect(result.path).toBe('/usr/local/bin/claude');
    expect(result.version).toBeNull();
  });

  it('which claude가 빈 문자열이면 available: false를 반환한다', () => {
    mockExecSync.mockReturnValueOnce('  ');

    const result = checkClaudeCli();

    expect(result.available).toBe(false);
    expect(result.error).toBe('claude not in PATH');
  });

  it('which claude가 실패하면 available: false를 반환한다', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });

    const result = checkClaudeCli();

    expect(result.available).toBe(false);
    expect(result.path).toBeNull();
    expect(result.version).toBeNull();
    expect(result.error).toBe('claude CLI를 찾을 수 없습니다');
  });
});

// ── getSetupStatus ──────────────────────────────────────────────────

describe('getSetupStatus', () => {
  it('설정 파일과 CLI가 모두 있으면 isConfigured: true', () => {
    const config = {
      gateway: { mode: 'local', port: 18789, bind: 'loopback', auth: { mode: 'none' } },
      agents: { defaults: { model: 'claude-cli/claude-sonnet-4-6' } },
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(config));
    mockExecSync
      .mockReturnValueOnce('/usr/local/bin/claude')
      .mockReturnValueOnce('1.0.0');

    const status = getSetupStatus();

    expect(status.isConfigured).toBe(true);
    expect(status.configExists).toBe(true);
    expect(status.currentModel).toBe('claude-cli/claude-sonnet-4-6');
    expect(status.claudeCli.available).toBe(true);
  });

  it('설정 파일이 없으면 isConfigured: false', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync
      .mockReturnValueOnce('/usr/local/bin/claude')
      .mockReturnValueOnce('1.0.0');

    const status = getSetupStatus();

    expect(status.isConfigured).toBe(false);
    expect(status.configExists).toBe(false);
    expect(status.currentModel).toBeNull();
  });

  it('CLI가 없으면 isConfigured: false', () => {
    const config = {
      gateway: { mode: 'local', port: 18789, bind: 'loopback', auth: { mode: 'none' } },
      agents: { defaults: { model: 'claude-cli/claude-sonnet-4-6' } },
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(config));
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });

    const status = getSetupStatus();

    expect(status.isConfigured).toBe(false);
    expect(status.configExists).toBe(true);
    expect(status.claudeCli.available).toBe(false);
  });

  it('모델이 claude-cli/ 접두사가 아니면 isConfigured: false', () => {
    const config = {
      gateway: { mode: 'local', port: 18789, bind: 'loopback', auth: { mode: 'none' } },
      agents: { defaults: { model: 'openai/gpt-4' } },
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(config));
    mockExecSync
      .mockReturnValueOnce('/usr/local/bin/claude')
      .mockReturnValueOnce('1.0.0');

    const status = getSetupStatus();

    expect(status.isConfigured).toBe(false);
    expect(status.currentModel).toBe('openai/gpt-4');
  });

  it('configPath가 항상 포함된다', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });

    const status = getSetupStatus();

    expect(status.configPath).toContain('openclaw.json');
  });
});
