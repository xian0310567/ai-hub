/**
 * OpenClaw Gateway 프로세스 매니저
 *
 * Gateway를 자동으로 시작/모니터/재시작한다.
 * electron-app 서버 시작 시 init()을 호출하면 된다.
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { isGatewayAvailable } from './openclaw-client.js';

// ── 상태 ──────────────────────────────────────────────────────────────

export type GatewayState = 'stopped' | 'starting' | 'running' | 'error';

let _state: GatewayState = 'stopped';
let _process: ChildProcess | null = null;
let _healthCheckInterval: ReturnType<typeof setInterval> | null = null;
let _restartCount = 0;
const MAX_RESTARTS = 5;
const HEALTH_CHECK_INTERVAL_MS = 15_000;
const STARTUP_TIMEOUT_MS = 10_000;

// ── 로그 스트리밍 ──────────────────────────────────────────────���─────

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

/** OpenClaw CLI 바이너리 경로를 탐지한다. */
function findOpenClawBinary(): string | null {
  const envPath = process.env.OPENCLAW_CLI_PATH;
  if (envPath) return envPath;

  try {
    return execSync('which openclaw', { encoding: 'utf8', timeout: 3000 }).trim() || null;
  } catch {
    // PATH에 없는 경우 npm global 경로 탐색
    const candidates = [
      'openclaw',
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
export async function startGateway(manual = false): Promise<{ ok: boolean; reason?: string }> {
  // 수동 호출 시 카운터 리셋
  if (manual) _restartCount = 0;

  // 이미 starting 중이면 중복 방지
  if (_state === 'starting') {
    return { ok: false, reason: 'already_starting' };
  }

  // 이미 실행 중인 Gateway 확인
  if (await isGatewayAvailable()) {
    _state = 'running';
    startHealthCheck();
    return { ok: true, reason: 'already_running' };
  }

  const binary = findOpenClawBinary();
  if (!binary) {
    _state = 'error';
    return { ok: false, reason: 'openclaw_not_found' };
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
    if (configDir) args.push('--config', configDir);

    _process = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT,
        OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
        OPENCLAW_CONFIG_DIR: process.env.OPENCLAW_CONFIG_DIR,
        DATA_DIR: process.env.DATA_DIR,
        NODE_ENV: process.env.NODE_ENV,
      },
    });

    // stdout/stderr 로그 캡처
    _process.stdout?.on('data', (chunk: Buffer) => pushLog('stdout', chunk));
    _process.stderr?.on('data', (chunk: Buffer) => pushLog('stderr', chunk));

    _process.on('exit', (code) => {
      _state = 'stopped';
      _process = null;

      if (code !== 0 && _restartCount < MAX_RESTARTS) {
        _restartCount++;
        setTimeout(() => startGateway(), 2000 * _restartCount);
      }
    });

    _process.on('error', () => {
      _state = 'error';
      _process = null;
    });

    // 시작 대기
    const started = await waitForGateway(STARTUP_TIMEOUT_MS);
    if (started) {
      _state = 'running';
      _restartCount = 0;
      startHealthCheck();
      return { ok: true };
    }

    _state = 'error';
    return { ok: false, reason: 'startup_timeout' };
  } catch (err: unknown) {
    _state = 'error';
    return { ok: false, reason: err instanceof Error ? err.message : 'unknown' };
  }
}

/**
 * Gateway를 정지한다.
 */
export function stopGateway(): void {
  stopHealthCheck();
  if (_process) {
    _process.kill('SIGTERM');
    _process = null;
  }
  _state = 'stopped';
}

/**
 * Gateway 상태를 종합적으로 반환한다.
 */
export async function getGatewayInfo(): Promise<{
  state: GatewayState;
  pid: number | null;
  restartCount: number;
  available: boolean;
  port: string;
}> {
  const available = await isGatewayAvailable();
  if (available && _state !== 'running') _state = 'running';
  if (!available && _state === 'running') _state = 'stopped';

  return {
    state: _state,
    pid: getGatewayPid(),
    restartCount: _restartCount,
    available,
    port: GATEWAY_PORT,
  };
}

// ── Internal ──────────────────────────────────────────────────────────

async function waitForGateway(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
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
      // 자동 재시작 시도 (backoff 적용)
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

// ── Auto Start ───────────────────────────────────────────────────────

/**
 * 설정에 따라 Gateway를 자동 시작한다.
 * server.ts 부팅 시 호출된다.
 */
export async function initGatewayAutoStart(): Promise<void> {
  try {
    // 동적 import로 순환 의존 방지 — Settings는 db.ts에 있음
    const { Settings } = await import('./db.js');
    const autoStart = Settings.get('gateway_auto_start');
    if (autoStart === 'true') {
      console.log('[Gateway] 자동 시작 설정 감지 — 시작 시도');
      const result = await startGateway();
      if (result.ok) {
        console.log(`[Gateway] 자동 시작 성공 (${result.reason ?? 'started'})`);
      } else {
        console.warn(`[Gateway] 자동 시작 실패: ${result.reason}`);
      }
    }
  } catch (err) {
    console.warn('[Gateway] 자동 시작 초기화 오류:', err instanceof Error ? err.message : err);
  }
}
