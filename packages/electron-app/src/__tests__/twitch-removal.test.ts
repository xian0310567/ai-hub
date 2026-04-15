/**
 * Twitch 플러그인 제거 검증 테스트
 *
 * Twitch 확장이 완전히 제거되었는지, 그리고 제거 후 게이트웨이
 * 헬스체크가 정상 동작하는지 검증한다.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { readFileSync } from 'fs';
import path from 'path';

const OPENCLAW_ROOT = path.resolve(__dirname, '../../../openclaw');

describe('Twitch plugin removal', () => {
  it('extensions/twitch directory does not exist', () => {
    expect(existsSync(path.join(OPENCLAW_ROOT, 'extensions/twitch'))).toBe(false);
  });

  it('plugin-sdk/twitch.ts source does not exist', () => {
    expect(existsSync(path.join(OPENCLAW_ROOT, 'src/plugin-sdk/twitch.ts'))).toBe(false);
  });

  it('dist does not contain twitch extension', () => {
    expect(existsSync(path.join(OPENCLAW_ROOT, 'dist/extensions/twitch'))).toBe(false);
  });

  it('docs/channels/twitch.md does not exist', () => {
    expect(existsSync(path.join(OPENCLAW_ROOT, 'docs/channels/twitch.md'))).toBe(false);
  });

  it('package.json does not export plugin-sdk/twitch', () => {
    const pkg = JSON.parse(readFileSync(path.join(OPENCLAW_ROOT, 'package.json'), 'utf-8'));
    expect(pkg.exports?.['./plugin-sdk/twitch']).toBeUndefined();
  });

  it('plugin-sdk-entrypoints.json does not include twitch', () => {
    const entries = JSON.parse(
      readFileSync(path.join(OPENCLAW_ROOT, 'scripts/lib/plugin-sdk-entrypoints.json'), 'utf-8'),
    );
    expect(entries).not.toContain('twitch');
  });

  it('bundled-runtime-sidecar-paths.json does not include twitch', () => {
    const paths = JSON.parse(
      readFileSync(path.join(OPENCLAW_ROOT, 'scripts/lib/bundled-runtime-sidecar-paths.json'), 'utf-8'),
    );
    const hasTwitch = paths.some((p: string) => p.includes('twitch'));
    expect(hasTwitch).toBe(false);
  });

  it('bundled-channel-config-metadata does not reference twitch', () => {
    const content = readFileSync(
      path.join(OPENCLAW_ROOT, 'src/config/bundled-channel-config-metadata.generated.ts'),
      'utf-8',
    );
    expect(content).not.toContain('"twitch"');
  });
});

describe('Gateway health check resilience', () => {
  it('isGatewayAvailable returns true for any HTTP response (including 500)', async () => {
    const { isGatewayAvailable } = await import('../lib/openclaw-client.js');

    // Mock fetch to simulate a 500 response (plugin error scenario)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 500 })) as any;

    try {
      const result = await isGatewayAvailable();
      expect(result).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('isGatewayAvailable returns false only for network errors', async () => {
    const { isGatewayAvailable } = await import('../lib/openclaw-client.js');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error('ECONNREFUSED'); }) as any;

    try {
      const result = await isGatewayAvailable();
      expect(result).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
