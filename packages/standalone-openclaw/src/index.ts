/**
 * standalone-openclaw
 *
 * OpenClaw + Claude CLI를 electron-app / vm-server 없이 독립적으로 사용하기 위한 패키지.
 *
 * openclaw 패키지를 기반으로 하되, Claude CLI 바이너리를 백엔드로 사용하도록
 * 자동 설정하고, 간편한 프로그래밍 API를 제공합니다.
 *
 * @example
 * ```typescript
 * import { setup, startGateway, runAgent } from 'standalone-openclaw';
 *
 * // 1. Claude CLI 백엔드 설정 (최초 1회)
 * setup();
 *
 * // 2. Gateway 시작 (선택 — 없으면 CLI 직접 호출로 동작)
 * const gw = await startGateway({ port: 18789 });
 *
 * // 3. 에이전트 실행
 * const result = await runAgent({
 *   message: '현재 디렉터리의 구조를 설명해주세요.',
 *   cwd: '/my/project',
 * });
 * console.log(result.output);
 *
 * // 4. 정리
 * await gw.close();
 * ```
 */

// ── Setup & Config ───────────────────────────────────────────────────
export {
  setup,
  diagnose,
  readExistingConfig,
  SUPPORTED_MODELS,
  DEFAULT_MODEL,
} from './setup.js';

export type {
  SetupOptions,
  SetupResult,
  StandaloneConfig,
} from './setup.js';

// ── Claude CLI Resolver ──────────────────────────────────────────────
export {
  resolveClaudeCli,
} from './claude-cli-resolver.js';

export type {
  ClaudeCliInfo,
} from './claude-cli-resolver.js';

// ── Gateway ──────────────────────────────────────────────────────────
export {
  startGateway,
  isGatewayAlive,
  isGatewayReady,
} from './gateway.js';

export type {
  GatewayOptions,
  GatewayHandle,
} from './gateway.js';

// ── Agent Execution ──────────────────────────────────────────────────
export {
  runAgent,
} from './agent.js';

export type {
  AgentRunOptions,
  AgentRunResult,
} from './agent.js';

// ── OpenClaw re-exports (핵심 유틸리티) ──────────────────────────────
// openclaw 패키지의 주요 API를 re-export하여 직접 접근 가능하게 함
export {
  loadConfig,
  loadSessionStore,
  saveSessionStore,
  resolveStorePath,
  deriveSessionKey,
  resolveSessionKey,
  createDefaultDeps,
  waitForever,
} from 'openclaw';
