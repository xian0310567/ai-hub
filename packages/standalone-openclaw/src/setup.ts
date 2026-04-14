/**
 * OpenClaw + Claude CLI 자동 설정
 *
 * openclaw의 설정 파일(~/.openclaw/openclaw.json)을 생성하고
 * claude-cli를 기본 백엔드로 설정합니다.
 *
 * 이 모듈은 openclaw의 loadConfig/config API를 사용하여
 * 실제 openclaw이 인식하는 설정을 생성합니다.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { resolveClaudeCli, type ClaudeCliInfo } from './claude-cli-resolver.js';

// ── 경로 ─────────────────────────────────────────────────────────────

const OPENCLAW_DIR = process.env.OPENCLAW_STATE_DIR
  || path.join(process.env.HOME || '', '.openclaw');
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH
  || path.join(OPENCLAW_DIR, 'openclaw.json');

// ── 타입 ─────────────────────────────────────────────────────────────

export interface StandaloneConfig {
  gateway: {
    mode: 'local';
    port: number;
    bind: 'loopback' | 'lan';
    auth: { mode: 'none' };
    http: {
      endpoints: {
        chatCompletions: { enabled: boolean };
        responses?: { enabled: boolean };
      };
    };
  };
  agents: {
    defaults: {
      model: string;
      cliBackends: {
        'claude-cli': {
          command: string;
        };
      };
    };
  };
}

export interface SetupOptions {
  /** Claude CLI 바이너리 경로 (미지정 시 자동 탐지) */
  claudePath?: string;
  /** 기본 모델 (미지정 시 claude-sonnet-4-6) */
  model?: string;
  /** Gateway 포트 (기본 18789) */
  port?: number;
  /** Gateway 바인드 (기본 loopback) */
  bind?: 'loopback' | 'lan';
  /** 기존 설정 덮어쓰기 (기본 false) */
  force?: boolean;
}

export interface SetupResult {
  ok: boolean;
  configPath: string;
  claudeCli: ClaudeCliInfo;
  model: string;
  error?: string;
}

// ── 지원 모델 ────────────────────────────────────────────────────────

export const SUPPORTED_MODELS = [
  { id: 'claude-cli/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', default: true },
  { id: 'claude-cli/claude-opus-4-6',   label: 'Claude Opus 4.6' },
  { id: 'claude-cli/claude-haiku-4-5',  label: 'Claude Haiku 4.5' },
] as const;

export const DEFAULT_MODEL = 'claude-cli/claude-sonnet-4-6';

// ── 설정 생성 ────────────────────────────────────────────────────────

/**
 * openclaw.json을 생성하고 claude-cli를 기본 백엔드로 설정합니다.
 * 기존 설정이 있으면 force=true가 아닌 한 건너뜁니다.
 */
export function setup(opts: SetupOptions = {}): SetupResult {
  const claudeCli = opts.claudePath
    ? { path: opts.claudePath, version: null, resolved: true } as ClaudeCliInfo
    : resolveClaudeCli();

  if (!claudeCli.resolved && !opts.claudePath) {
    return {
      ok: false,
      configPath: CONFIG_PATH,
      claudeCli,
      model: opts.model || DEFAULT_MODEL,
      error: 'Claude CLI를 찾을 수 없습니다. npm i -g @anthropic-ai/claude-code 로 설치하거나 claudePath 옵션을 지정하세요.',
    };
  }

  // 기존 설정이 있고 force가 아니면 건너뛰기
  if (existsSync(CONFIG_PATH) && !opts.force) {
    const existing = readExistingConfig();
    if (existing) {
      return {
        ok: true,
        configPath: CONFIG_PATH,
        claudeCli,
        model: existing.agents?.defaults?.model || opts.model || DEFAULT_MODEL,
      };
    }
  }

  const model = opts.model || DEFAULT_MODEL;
  const config: StandaloneConfig = {
    gateway: {
      mode: 'local',
      port: opts.port ?? parseInt(process.env.OPENCLAW_GATEWAY_PORT || '18789', 10),
      bind: opts.bind ?? 'loopback',
      auth: { mode: 'none' },
      http: {
        endpoints: {
          chatCompletions: { enabled: true },
        },
      },
    },
    agents: {
      defaults: {
        model,
        cliBackends: {
          'claude-cli': {
            command: claudeCli.path,
          },
        },
      },
    },
  };

  mkdirSync(OPENCLAW_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');

  return {
    ok: true,
    configPath: CONFIG_PATH,
    claudeCli,
    model,
  };
}

/**
 * 현재 설정을 읽어 반환합니다.
 */
export function readExistingConfig(): StandaloneConfig | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 현재 설정 상태를 진단합니다.
 */
export function diagnose(): {
  configExists: boolean;
  configPath: string;
  claudeCli: ClaudeCliInfo;
  currentModel: string | null;
  isClaudeCliBackend: boolean;
  ready: boolean;
} {
  const claudeCli = resolveClaudeCli();
  const config = readExistingConfig();
  const currentModel = config?.agents?.defaults?.model ?? null;
  const isClaudeCliBackend = !!(currentModel?.startsWith('claude-cli/'));
  const hasCliCommand = !!(config?.agents?.defaults?.cliBackends?.['claude-cli']?.command);

  return {
    configExists: config !== null,
    configPath: CONFIG_PATH,
    claudeCli,
    currentModel,
    isClaudeCliBackend,
    ready: config !== null && isClaudeCliBackend && claudeCli.resolved && hasCliCommand,
  };
}
