/**
 * openclaw 패키지의 타입 선언 (외부 의존)
 *
 * openclaw은 자체 .d.ts를 제공하지 않으므로
 * standalone-openclaw에서 사용하는 API만 선언합니다.
 */

declare module 'openclaw' {
  export function loadConfig(): unknown;
  export function loadSessionStore(storePath: string): Promise<unknown>;
  export function saveSessionStore(storePath: string, data: unknown): Promise<void>;
  export function resolveStorePath(configDir?: string): string;
  export function deriveSessionKey(...args: unknown[]): string;
  export function resolveSessionKey(...args: unknown[]): string;
  export function createDefaultDeps(): unknown;
  export function waitForever(): Promise<never>;
}

declare module 'openclaw/dist/gateway/server.js' {
  export interface GatewayServer {
    close(opts?: { reason?: string; restartExpectedMs?: number | null }): Promise<void>;
  }

  export interface GatewayServerOptions {
    bind?: 'loopback' | 'lan' | 'tailnet' | 'auto';
    host?: string;
    controlUiEnabled?: boolean;
    openAiChatCompletionsEnabled?: boolean;
    openResponsesEnabled?: boolean;
  }

  export function startGatewayServer(
    port?: number,
    opts?: GatewayServerOptions,
  ): Promise<GatewayServer>;
}
