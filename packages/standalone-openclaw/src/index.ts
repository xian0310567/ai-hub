/**
 * standalone-openclaw
 *
 * electron-app / vm-server 없이 OpenClaw + Claude CLI를 독립적으로 사용하기 위한 패키지.
 *
 * 주요 기능:
 * - Claude CLI 바이너리 탐지 및 실행
 * - OpenClaw Gateway 프로세스 관리 (시작/정지/모니터)
 * - OpenClaw Gateway HTTP 클라이언트 (SSE 스트리밍/비스트리밍)
 * - 에이전트 실행 (Gateway 우선, CLI 폴백)
 * - 크론 작업 관리
 * - 설정 파일 관리
 *
 * @example
 * ```typescript
 * import {
 *   agentRun,
 *   startGateway,
 *   ensureGatewayReady,
 *   getSetupStatus,
 *   buildDefaultConfig,
 *   writeConfig,
 * } from 'standalone-openclaw';
 *
 * // 1. 설정 초기화
 * const config = buildDefaultConfig('claude-cli/claude-sonnet-4-6');
 * writeConfig(config);
 *
 * // 2. Gateway 시작
 * await startGateway();
 * await ensureGatewayReady();
 *
 * // 3. 에이전트 실행 (Gateway 우선, 실패 시 Claude CLI 직접 호출)
 * const result = await agentRun({
 *   message: '안녕하세요, 현재 시간을 알려주세요.',
 *   model: 'claude-sonnet-4-6',
 *   cwd: '/my/project',
 * });
 *
 * console.log(result.output);
 * ```
 */

// ── Claude CLI ───────────────────────────────────────────────────────
export {
  CLAUDE_CLI,
  CLAUDE_ENV,
  claudeSpawnError,
} from './claude-cli.js';

// ── OpenClaw Config ──────────────────────────────────────────────────
export {
  readConfig,
  writeConfig,
  buildDefaultConfig,
  checkClaudeCli,
  getSetupStatus,
  SUPPORTED_MODELS,
  DEFAULT_MODEL,
} from './openclaw-config.js';

export type {
  OpenClawConfig,
  ClaudeCliStatus,
  OpenClawSetupStatus,
} from './openclaw-config.js';

// ── OpenClaw Gateway Client ──────────────────────────────────────────
export {
  isGatewayAvailable,
  isGatewayReady,
  sendToGateway,
  sendToGatewaySync,
  getSessionHistory,
  killSession,
  getGatewayStatus,
} from './openclaw-client.js';

export type {
  OpenClawMessage,
  OpenClawSendOptions,
  OpenClawStreamChunk,
} from './openclaw-client.js';

// ── Gateway Process Manager ──────────────────────────────────────────
export {
  startGateway,
  stopGateway,
  ensureGatewayReady,
  getGatewayInfo,
  getGatewayState,
  getGatewayPid,
  getRestartCount,
  findOpenClawBinary,
  isOpenClawNeedsBuild,
  gatewayLogs,
  getLogBuffer,
  clearLogBuffer,
} from './gateway-manager.js';

export type {
  GatewayState,
  GatewayLogEntry,
} from './gateway-manager.js';

// ── Agent Executor ───────────────────────────────────────────────────
export {
  agentRun,
  executeWithFallback,
  cronAdd,
  cronList,
  cronRemove,
  cronEnable,
  cronDisable,
} from './openclaw-executor.js';

export type {
  AgentRunParams,
  AgentResult,
  CronAddParams,
  CronJob,
  CronResult,
} from './openclaw-executor.js';
