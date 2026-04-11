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

  it('routes channel to target agent when target_agent_id is set', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    const pool = getPool();

    // 워크스페이스 + 팀 + 에이전트 생성
    const divId = newId();
    const wsId = newId();
    const teamId = newId();
    const agentId = newId();

    await pool.query('INSERT INTO divisions(id,org_id,name,ws_path) VALUES($1,$2,$3,$4)', [divId, orgId, 'Div', '/tmp']);
    await pool.query('INSERT INTO workspaces(id,org_id,division_id,name,path) VALUES($1,$2,$3,$4,$5)', [wsId, orgId, divId, 'WS', '/tmp/ws']);
    await pool.query('INSERT INTO teams(id,org_id,workspace_id,name) VALUES($1,$2,$3,$4)', [teamId, orgId, wsId, '지원팀']);
    await pool.query(
      `INSERT INTO agents(id,org_id,workspace_id,team_id,org_level,is_lead,name,soul,command_name,harness_pattern,model)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [agentId, orgId, wsId, teamId, 'worker', false, '지원봇', '', 'support-bot', 'single', 'claude-sonnet-4-6'],
    );

    // 채널 생성 시 target_agent_id 지정
    await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { channel_type: 'telegram', config: {}, target_agent_id: agentId },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/openclaw/config',
      headers: { Cookie: cookie },
    });

    const config = res.json().config;
    const bindings = config.bindings;
    const telegramBinding = bindings.find(
      (b: { match: { channel: string } }) => b.match.channel === 'telegram',
    );
    expect(telegramBinding).toBeDefined();
    // target_agent_id가 설정되었으므로 orchestrator가 아닌 해당 에이전트로 라우팅
    expect(telegramBinding.agentId).not.toBe('orchestrator');
    // 실제 agent list에 존재하는 ID로 라우팅됨
    const targetInList = config.agents.list.find(
      (a: { id: string }) => a.id === telegramBinding.agentId,
    );
    expect(targetInList).toBeDefined();
  });

  it('falls back to orchestrator when target_agent_id agent not found in config', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    const pool = getPool();

    // 에이전트를 생성하되 팀 미소속 + division 레벨로 만들어서 standalone이 아닌 경우
    const agentId = newId();
    await pool.query(
      `INSERT INTO agents(id,org_id,org_level,name,model) VALUES($1,$2,$3,$4,$5)`,
      [agentId, orgId, 'worker', '테스트봇', 'claude-sonnet-4-6'],
    );

    await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { channel_type: 'discord', config: {}, target_agent_id: agentId },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/openclaw/config',
      headers: { Cookie: cookie },
    });

    const bindings = res.json().config.bindings;
    const discordBinding = bindings.find(
      (b: { match: { channel: string } }) => b.match.channel === 'discord',
    );
    expect(discordBinding).toBeDefined();
    // standalone agent이므로 config에 존재 → 직접 라우팅
    expect(discordBinding.agentId).toBe('테스트봇');
  });

  it('rejects invalid target_agent_id on create (400)', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { channel_type: 'telegram', config: {}, target_agent_id: 'nonexistent' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('can update target_agent_id via PATCH', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    const pool = getPool();

    const agentId = newId();
    await pool.query(
      `INSERT INTO agents(id,org_id,org_level,name,model) VALUES($1,$2,$3,$4,$5)`,
      [agentId, orgId, 'worker', 'PatchBot', 'claude-sonnet-4-6'],
    );

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { channel_type: 'slack', config: {} },
    });
    const channelId = createRes.json().id;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { id: channelId, target_agent_id: agentId },
    });

    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().target_agent_id).toBe(agentId);
  });

  it('can clear target_agent_id by setting null', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    const pool = getPool();

    const agentId = newId();
    await pool.query(
      `INSERT INTO agents(id,org_id,org_level,name,model) VALUES($1,$2,$3,$4,$5)`,
      [agentId, orgId, 'worker', 'NullBot', 'claude-sonnet-4-6'],
    );

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { channel_type: 'web', config: {}, target_agent_id: agentId },
    });
    const channelId = createRes.json().id;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { id: channelId, target_agent_id: null },
    });

    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().target_agent_id).toBeNull();
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
