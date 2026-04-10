/**
 * Integration tests for /api/openclaw/channels (채널 관리 + Telegram 연동)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { buildApp } from './helpers/app.js';
import { clearDb, seedUser, q1, newId } from './helpers/db.js';
import { getPool } from '../db/pool.js';

const TEST_DIR = path.join(os.tmpdir(), 'aihub-channels-test');

let app: FastifyInstance;

beforeAll(async () => {
  process.env.DATA_DIR = TEST_DIR;
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});
beforeEach(async () => {
  await clearDb();
  fs.rmSync(path.join(TEST_DIR, 'openclaw-runtime'), { recursive: true, force: true });
});

// ── POST /api/openclaw/channels ───────────────────────────────────────

describe('POST /api/openclaw/channels — add channel', () => {
  it('creates a Telegram channel (201)', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: {
        channel_type: 'telegram',
        config: {
          botToken: 'test-bot-token',
          allowedChatIds: ['-1001234567890'],
        },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.channel_type).toBe('telegram');
    expect(JSON.parse(body.config).botToken).toBe('test-bot-token');
  });

  it('rejects unsupported channel type (400)', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { channel_type: 'fax' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects duplicate channel (409)', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });

    await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { channel_type: 'telegram', config: {} },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { channel_type: 'telegram', config: {} },
    });

    expect(res.statusCode).toBe(409);
  });

  it('non-admin cannot create (403)', async () => {
    const { cookie } = await seedUser({ role: 'member' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { channel_type: 'telegram', config: {} },
    });

    expect(res.statusCode).toBe(403);
  });
});

// ── GET /api/openclaw/channels ────────────────────────────────────────

describe('GET /api/openclaw/channels — list channels', () => {
  it('returns all channels for the org', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });

    await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { channel_type: 'telegram', config: { botToken: 't1' } },
    });

    await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { channel_type: 'discord', config: { token: 'd1' } },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });
});

// ── PATCH /api/openclaw/channels ──────────────────────────────────────

describe('PATCH /api/openclaw/channels — update channel', () => {
  it('updates channel config', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { channel_type: 'telegram', config: { botToken: 'old' } },
    });
    const channelId = createRes.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { id: channelId, config: { botToken: 'new-token' } },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.json().config).botToken).toBe('new-token');
  });

  it('can disable a channel', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { channel_type: 'telegram', config: {} },
    });
    const channelId = createRes.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { id: channelId, enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
  });
});

// ── DELETE /api/openclaw/channels ─────────────────────────────────────

describe('DELETE /api/openclaw/channels', () => {
  it('deletes a channel', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { channel_type: 'telegram', config: {} },
    });
    const channelId = createRes.json().id;

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { id: channelId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});

// ── Sync에 채널이 반영되는지 검증 ─────────────────────────────────────

describe('Channel config in sync output', () => {
  it('includes enabled channels in generated config', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });

    await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: {
        channel_type: 'telegram',
        config: { botToken: 'my-bot-token' },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/openclaw/config',
      headers: { Cookie: cookie },
    });

    const config = res.json().config;
    expect(config.channels).toBeDefined();
    expect(config.channels.telegram).toBeDefined();
    expect(config.channels.telegram.botToken).toBe('my-bot-token');
  });

  it('telegram binding routes to orchestrator', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });

    await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { channel_type: 'telegram', config: {} },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/openclaw/config',
      headers: { Cookie: cookie },
    });

    const bindings = res.json().config.bindings;
    const telegramBinding = bindings.find(
      (b: { match: { channel: string } }) => b.match.channel === 'telegram',
    );
    expect(telegramBinding).toBeDefined();
    expect(telegramBinding.agentId).toBe('orchestrator');
  });

  it('disabled channels are excluded from config', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { channel_type: 'telegram', config: { botToken: 'x' } },
    });

    await app.inject({
      method: 'PATCH',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { id: createRes.json().id, enabled: false },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/openclaw/config',
      headers: { Cookie: cookie },
    });

    const config = res.json().config;
    expect(config.channels).toBeUndefined();
  });
});
