/**
 * OpenClaw Gateway 프로세스 매니저 (standalone)
 *
 * Gateway를 자동으로 시작/모니터/재시작한다.
 * electron-app의 SQLite/Settings 의존 없이 독립적으로 동작한다.
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { isGatewayAvailable, isGatewayReady } from './openclaw-client.js';
import { readConfig, writeConfig } from './openclaw-config.js';

// ── 상태 ──────────────────────────────────────────────────────────────

export type GatewayState = 'stopped' | 'starting' | 'running' | 'error';

let _state: GatewayState = 'stopped';
let _lastError: string | null = null;
let _process: ChildProcess | null = null;
let _healthCheckInterval: ReturnType<typeof setInterval> | null = null;
let _restartCount = 0;
const MAX_RESTARTS = 5;
const HEALTH_CHECK_INTERVAL_MS = 15_000;
const STARTUP_TIMEOUT_MS = 90_000;

// ── 로그 스트리밍 ────────────────────────────────────────────────────

export interface GatewayLogEntry {
  ts: number;
  stream: 'stdout' | 'stderr';
  line: string;
}

export const gatewayLogs = new EventEmitter();
const LOG_BUFFER_SIZE = 500;
const _logBuffer: GatewayLogEntry[] = [];

function pushLog(stream: 'stdout' | 'stderr', chunk: Buffer): void {
  const lines = chunk.toString().split('\n').filter(Boolean);
  for (const line of lines) {
    const entry: GatewayLogEntry = { ts: Date.now(), stream, line };
    _logBuffer.push(entry);
    if (_logBuffer.length > LOG_BUFFER_SIZE) _logBuffer.shift();
    gatewayLogs.emit('log', entry);
  }
}

export function getLogBuffer(): GatewayLogEntry[] {
  return [..._logBuffer];
}

export function clearLogBuffer(): void {
  _logBuffer.length = 0;
}

// ── 설정 ──────────────────────────────────────────────────────────────

const GATEWAY_PORT = process.env.OPENCLAW_GATEWAY_PORT || '18789';
const GATEWAY_BIND = process.env.OPENCLAW_GATEWAY_BIND || 'loopback';

let _needsBuild = false;
export function isOpenClawNeedsBuild(): boolean { return _needsBuild; }

/** OpenClaw CLI 바이너리 경로를 탐지한다. */
export function findOpenClawBinary(): string | null {
  _needsBuild = false;

  // 1. 환경변수로 직접 지정
  const envPath = process.env.OPENCLAW_CLI_PATH;
  if (envPath) return envPath;

  // 2. 모노레포 워크스페이스 패키지 (packages/openclaw)
  const localCandidates = [
    path.resolve(process.cwd(), '..', 'openclaw'),
    path.resolve(process.cwd(), '..', '..', 'packages', 'openclaw'),
  ];
  for (const localDir of localCandidates) {
    const mjs = path.join(localDir, 'openclaw.mjs');
    if (existsSync(mjs)) {
      const hasDistJs = existsSync(path.join(localDir, 'dist', 'entry.js'));
      const hasDistMjs = existsSync(path.join(localDir, 'dist', 'entry.mjs'));
      if (hasDistJs || hasDistMjs) {
        return mjs;
      }
      _needsBuild = true;
      console.warn(`[Gateway] 로컬 OpenClaw 패키지 발견: ${localDir} (빌드 필요: pnpm --filter openclaw build)`);
      return null;
    }
  }

  // 3. 시스템 PATH에서 탐색
  try {
    return execSync('which openclaw', { encoding: 'utf8', timeout: 3000 }).trim() || null;
  } catch {
    // 4. 글로벌 설치 경로 탐색
    const candidates = [
      `${process.env.HOME}/.npm-global/bin/openclaw`,
      `${process.env.HOME}/.local/bin/openclaw`,
      '/usr/local/bin/openclaw',
    ];
    for (const bin of candidates) {
      try {
        execSync(`${bin} --version`, { encoding: 'utf8', timeout: 3000 });
        return bin;
      } catch {}
    }
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────

export function getGatewayState(): GatewayState {
  return _state;
}

export function getGatewayPid(): number | null {
  return _process?.pid ?? null;
}

export function getRestartCount(): number {
  return _restartCount;
}

/**
 * Gateway를 시작한다. 이미 외부에서 실행 중이면 연결만 확인한다.
 */
export async function startGateway(manual = false): Promise<{ ok: boolean; reason?: string; detail?: string }> {
  if (manual) _restartCount = 0;

  if (_state === 'starting') {
    return { ok: false, reason: 'already_starting' };
  }

  // 이미 실행 중인 Gateway 확인
  if (await isGatewayAvailable()) {
    _state = 'running';
    _lastError = null;
    startHealthCheck();
    return { ok: true, reason: 'already_running' };
  }

  const binary = findOpenClawBinary();
  if (!binary) {
    _state = 'error';
    _lastError = _needsBuild ? 'openclaw_not_built' : 'openclaw_not_found';
    return { ok: false, reason: _lastError };
  }

  _state = 'starting';

  try {
    const configDir = process.env.OPENCLAW_CONFIG_DIR || '';
    const args = [
      'gateway', 'run',
      '--bind', GATEWAY_BIND,
      '--port', GATEWAY_PORT,
      '--force',
    ];

    const config = readConfig();
    if (!config) {
      args.push('--allow-unconfigured');
    } else if (!config.gateway?.http?.endpoints?.chatCompletions?.enabled) {
      config.gateway.http = config.gateway.http ?? {};
      config.gateway.http.endpoints = config.gateway.http.endpoints ?? {};
      config.gateway.http.endpoints.chatCompletions = { enabled: true };
      writeConfig(config);
    }

    if (configDir) args.push('--config', configDir);

    let processDied = false;
    let processExitCode: number | null = null;

    const isWindows = process.platform === 'win32';
    const isMjs = binary.endsWith('.mjs');
    const spawnCmd = (isWindows && isMjs) ? 'node' : binary;
    const spawnArgs = (isWindows && isMjs) ? [binary, ...args] : args;

    _process = spawn(spawnCmd, spawnArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: '',
      },
    });

    _process.stdout?.on('data', (chunk: Buffer) => pushLog('stdout', chunk));
    _process.stderr?.on('data', (chunk: Buffer) => pushLog('stderr', chunk));

    _process.on('exit', (code) => {
      processDied = true;
      processExitCode = code;
      _process = null;

      if (_state === 'running') {
        _state = 'stopped';
        if (code !== 0 && _restartCount < MAX_RESTARTS) {
          _restartCount++;
          setTimeout(() => startGateway(), 2000 * _restartCount);
        }
      }
    });

    _process.on('error', (err) => {
      processDied = true;
      _lastError = err.message || 'process_error';
      _process = null;
    });

    const started = await waitForGateway(STARTUP_TIMEOUT_MS, () => processDied);
    if (started) {
      _state = 'running';
      _restartCount = 0;
      _lastError = null;
      startHealthCheck();
      return { ok: true };
    }

    if (processDied) {
      const recentStderr = _logBuffer
        .filter(l => l.stream === 'stderr')
        .slice(-5)
        .map(l => l.line)
        .join(' ');
      const recentStdout = _logBuffer
        .filter(l => l.stream === 'stdout')
        .slice(-5)
        .map(l => l.line)
        .join(' ');
      const errorDetail = recentStderr || recentStdout || `exit code ${processExitCode}`;
      _state = 'error';
      _lastError = errorDetail;
      return { ok: false, reason: 'process_crashed', detail: errorDetail };
    }

    _state = 'error';
    _lastError = 'startup_timeout';
    return { ok: false, reason: 'startup_timeout' };
  } catch (err: unknown) {
    _state = 'error';
    _lastError = err instanceof Error ? err.message : 'unknown';
    return { ok: false, reason: _lastError };
  }
}

/** Gateway를 정지한다. */
export function stopGateway(): void {
  stopHealthCheck();
  if (_process) {
    _process.kill('SIGTERM');
    _process = null;
  }
  _state = 'stopped';
}

/** Gateway 상태를 종합적으로 반환한다. */
export async function getGatewayInfo(): Promise<{
  state: GatewayState;
  pid: number | null;
  restartCount: number;
  available: boolean;
  port: string;
  lastError: string | null;
  needsBuild: boolean;
}> {
  const available = await isGatewayAvailable();
  if (available && _state !== 'running') {
    _state = 'running';
    _lastError = null;
  }
  if (!available && _state === 'running') _state = 'stopped';

  return {
    state: _state,
    pid: getGatewayPid(),
    restartCount: _restartCount,
    available,
    port: GATEWAY_PORT,
    lastError: _lastError,
    needsBuild: _needsBuild,
  };
}

/**
 * Gateway가 준비될 때까지 대기한다.
 * 미가동 시 자동 시작을 시도하고, 최대 waitMs까지 대기.
 */
export async function ensureGatewayReady(waitMs = 30_000): Promise<boolean> {
  if (await isGatewayReady()) return true;

  if (_state !== 'running' && _state !== 'starting') {
    await startGateway();
  }

  const start = Date.now();
  while (Date.now() - start < waitMs) {
    if (await isGatewayReady()) return true;
    await new Promise(r => setTimeout(r, 1000));
  }

  return false;
}

// ── Internal ──────────────────────────────────────────────────────────

async function waitForGateway(timeoutMs: number, shouldAbort?: () => boolean): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (shouldAbort?.()) return false;
    if (await isGatewayAvailable()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function startHealthCheck(): void {
  stopHealthCheck();
  _healthCheckInterval = setInterval(async () => {
    const alive = await isGatewayAvailable();
    if (alive) {
      _state = 'running';
    } else if (_state === 'running') {
      _state = 'stopped';
      if (_restartCount < MAX_RESTARTS) {
        _restartCount++;
        setTimeout(() => startGateway(), 2000 * _restartCount);
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

function stopHealthCheck(): void {
  if (_healthCheckInterval) {
    clearInterval(_healthCheckInterval);
    _healthCheckInterval = null;
  }
}
