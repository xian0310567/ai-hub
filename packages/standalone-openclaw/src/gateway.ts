/**
 * OpenClaw Gateway 래퍼 (standalone)
 *
 * openclaw의 startGatewayServer()를 감싸서
 * claude-cli 백엔드 설정이 완료된 상태로 Gateway를 시작합니다.
 * electron-app이나 vm-server 없이 독립적으로 동작합니다.
 */

import { setup, diagnose, type SetupOptions } from './setup.js';

export interface GatewayOptions {
  /** Gateway 포트 (기본 18789) */
  port?: number;
  /** 바인드 주소 (기본 loopback) */
  bind?: 'loopback' | 'lan';
  /** OpenAI 호환 /v1/chat/completions 엔드포인트 활성화 (기본 true) */
  chatCompletionsEnabled?: boolean;
  /** 설정 자동 초기화 옵션 */
  setupOptions?: SetupOptions;
}

export interface GatewayHandle {
  close: (opts?: { reason?: string }) => Promise<void>;
  port: number;
}

/**
 * OpenClaw Gateway를 시작합니다.
 *
 * 1. Claude CLI 백엔드로 설정이 안 되어 있으면 자동 설정
 * 2. openclaw의 startGatewayServer() 호출
 * 3. GatewayHandle 반환 (close() 호출로 정지)
 *
 * @example
 * ```typescript
 * const gw = await startGateway({ port: 18789 });
 * // ... 사용 ...
 * await gw.close();
 * ```
 */
export async function startGateway(opts: GatewayOptions = {}): Promise<GatewayHandle> {
  const port = opts.port ?? parseInt(process.env.OPENCLAW_GATEWAY_PORT || '18789', 10);
  const bind = opts.bind ?? 'loopback';

  // 설정이 준비되지 않았으면 자동 설정
  const status = diagnose();
  if (!status.ready) {
    const result = setup({
      port,
      bind,
      force: false,
      ...opts.setupOptions,
    });
    if (!result.ok) {
      throw new Error(`OpenClaw 설정 실패: ${result.error}`);
    }
  }

  // openclaw의 startGatewayServer를 동적 import로 호출
  // openclaw이 빌드된 상태여야 동작함
  const { startGatewayServer } = await import('openclaw/dist/gateway/server.js');

  const server = await startGatewayServer(port, {
    bind,
    openAiChatCompletionsEnabled: opts.chatCompletionsEnabled ?? true,
  });

  return {
    close: async (closeOpts) => {
      await server.close(closeOpts);
    },
    port,
  };
}

/**
 * Gateway 헬스체크 (HTTP /health 엔드포인트)
 */
export async function isGatewayAlive(port?: number): Promise<boolean> {
  const p = port ?? parseInt(process.env.OPENCLAW_GATEWAY_PORT || '18789', 10);
  try {
    await fetch(`http://127.0.0.1:${p}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Gateway가 요청을 처리할 준비가 되었는지 확인
 */
export async function isGatewayReady(port?: number): Promise<boolean> {
  const p = port ?? parseInt(process.env.OPENCLAW_GATEWAY_PORT || '18789', 10);
  try {
    const res = await fetch(`http://127.0.0.1:${p}/ready`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
