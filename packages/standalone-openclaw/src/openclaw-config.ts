/**
 * OpenClaw 설정 파일 관리 (standalone)
 *
 * ~/.openclaw/openclaw.json 설정 파일을 읽고 쓰며,
 * Claude CLI 상태를 확인합니다.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

// ── 경로 해석 ────────────────────────────────────────────────────

const OPENCLAW_DIR = process.env.OPENCLAW_STATE_DIR
  || path.join(process.env.HOME || '', '.openclaw');
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH
  || path.join(OPENCLAW_DIR, 'openclaw.json');

// ── 타입 ─────────────────────────────────────────────────────────

export interface OpenClawConfig {
  gateway: {
    mode: 'local';
    port: number;
    bind: 'loopback' | 'lan';
    auth: { mode: 'none' };
    http?: {
      endpoints?: {
        chatCompletions?: { enabled: boolean };
        responses?: { enabled: boolean };
      };
    };
  };
  agents: {
    defaults: {
      model: string;
      cliBackends?: {
        'claude-cli'?: {
          command?: string;
        };
      };
    };
  };
}

export const SUPPORTED_MODELS = [
  { id: 'claude-cli/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: '빠르고 균형 잡힌 모델 (권장)', default: true },
  { id: 'claude-cli/claude-opus-4-6',   label: 'Claude Opus 4.6',   description: '최고 성능, 느린 속도' },
  { id: 'claude-cli/claude-haiku-4-5',  label: 'Claude Haiku 4.5',  description: '빠른 응답, 가벼운 작업용' },
] as const;

export const DEFAULT_MODEL = 'claude-cli/claude-sonnet-4-6';

// ── 설정 파일 관리 ───────────────────────────────────────────────

/** 현재 openclaw.json 읽기. 없으면 null */
export function readConfig(): OpenClawConfig | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** openclaw.json 생성/덮어쓰기 */
export function writeConfig(config: OpenClawConfig): void {
  mkdirSync(OPENCLAW_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/** 기본 설정 생성 (claude-cli 백엔드, 지정 모델) */
export function buildDefaultConfig(model?: string, claudePath?: string): OpenClawConfig {
  const config: OpenClawConfig = {
    gateway: {
      mode: 'local',
      port: parseInt(process.env.OPENCLAW_GATEWAY_PORT || '18789', 10),
      bind: 'loopback',
      auth: { mode: 'none' },
      http: {
        endpoints: {
          chatCompletions: { enabled: true },
        },
      },
    },
    agents: {
      defaults: {
        model: model || DEFAULT_MODEL,
      },
    },
  };

  if (claudePath && claudePath !== 'claude') {
    config.agents.defaults.cliBackends = {
      'claude-cli': { command: claudePath },
    };
  }

  return config;
}

// ── Claude CLI 확인 ──────────────────────────────────────────────

export interface ClaudeCliStatus {
  available: boolean;
  path: string | null;
  version: string | null;
  error?: string;
}

/** claude CLI가 설치되어 있는지 확인 */
export function checkClaudeCli(): ClaudeCliStatus {
  try {
    const bin = execSync('which claude', { encoding: 'utf8', timeout: 5000 }).trim();
    if (!bin) return { available: false, path: null, version: null, error: 'claude not in PATH' };

    let version: string | null = null;
    try {
      version = execSync('claude --version', { encoding: 'utf8', timeout: 5000 }).trim();
    } catch {}

    return { available: true, path: bin, version };
  } catch {
    return { available: false, path: null, version: null, error: 'claude CLI를 찾을 수 없습니다' };
  }
}

// ── 종합 상태 ────────────────────────────────────────────────────

export interface OpenClawSetupStatus {
  configExists: boolean;
  configPath: string;
  currentModel: string | null;
  claudeCli: ClaudeCliStatus;
  isConfigured: boolean;
}

export function getSetupStatus(): OpenClawSetupStatus {
  const config = readConfig();
  const claudeCli = checkClaudeCli();
  const currentModel = config?.agents?.defaults?.model ?? null;
  const isConfigured = !!(
    config
    && config.gateway?.mode === 'local'
    && currentModel?.startsWith('claude-cli/')
    && claudeCli.available
  );

  return {
    configExists: config !== null,
    configPath: CONFIG_PATH,
    currentModel,
    claudeCli,
    isConfigured,
  };
}
