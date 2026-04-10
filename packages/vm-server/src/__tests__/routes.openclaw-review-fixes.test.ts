/**
 * Integration tests for OpenClaw 통합 코드 리뷰 수정 사항
 *
 * P0-1: PATCH 응답에서 org_id 검증
 * P0-2: materializeOpenClawWorkspace sync lock
 * P1-7: 채널 config JSON 파싱 실패 로깅
 * P1-8: 채널 DELETE 후 stored config 무효화
 * P2-13: toAgentId() 충돌 방지
 * P3-17: 채널 config 구조 검증
 * P3-18: fs 연산 에러 핸들링
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { buildApp } from './helpers/app.js';
import { clearDb, seedUser, q1, qall, newId } from './helpers/db.js';
import { getPool } from '../db/pool.js';

const TEST_DIR = path.join(os.tmpdir(), 'aihub-review-fixes-test');

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

// ── 헬퍼 ──────────────────────────────────────────────────────────────

async function seedAgentsForOrg(orgId: string) {
  const pool = getPool();
  const wsId = newId();
  const divId = newId();
  const teamId = newId();

  await pool.query(
    'INSERT INTO divisions(id,org_id,name,ws_path) VALUES($1,$2,$3,$4)',
    [divId, orgId, 'Division', TEST_DIR],
  );
  await pool.query(
    'INSERT INTO workspaces(id,org_id,division_id,name,path) VALUES($1,$2,$3,$4,$5)',
    [wsId, orgId, divId, 'WS', path.join(TEST_DIR, 'ws')],
  );
  await pool.query(
    'INSERT INTO teams(id,org_id,workspace_id,name,description) VALUES($1,$2,$3,$4,$5)',
    [teamId, orgId, wsId, '개발팀', '개발'],
  );

  const leadId = newId();
  await pool.query(
    `INSERT INTO agents(id,org_id,workspace_id,team_id,org_level,is_lead,name,soul,command_name,harness_pattern,model)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [leadId, orgId, wsId, teamId, 'team', true, '팀장', 'soul', null, 'orchestrator', 'claude-sonnet-4-6'],
  );

  return { wsId, divId, teamId, leadId };
}

// ── P0-1: PATCH 응답에서 org_id 검증 ────────────────────────────────

describe('P0-1: PATCH /api/openclaw/channels org_id 검증', () => {
  it('PATCH 응답이 org_id로 필터링됨', async () => {
    const { cookie: adminCookie, orgId } = await seedUser({ role: 'org_admin', username: 'admin1' });

    // 채널 생성
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: adminCookie },
      payload: { channel_type: 'telegram', config: { botToken: 'token1' } },
    });
    const channelId = createRes.json().id;

    // PATCH 후 응답에 org_id가 맞는 데이터만 포함
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/openclaw/channels',
      headers: { Cookie: adminCookie },
      payload: { id: channelId, config: { botToken: 'token2' } },
    });

    expect(patchRes.statusCode).toBe(200);
    const body = patchRes.json();
    expect(body.org_id).toBe(orgId);
    expect(JSON.parse(body.config).botToken).toBe('token2');
  });

  it('다른 조직의 채널은 PATCH할 수 없음 (404)', async () => {
    const { cookie: cookie1 } = await seedUser({ role: 'org_admin', username: 'admin1', orgSlug: 'org1' });
    const { cookie: cookie2 } = await seedUser({ role: 'org_admin', username: 'admin2', orgSlug: 'org2' });

    // org1에 채널 생성
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie1 },
      payload: { channel_type: 'telegram', config: { botToken: 'secret' } },
    });
    const channelId = createRes.json().id;

    // org2에서 org1 채널을 PATCH 시도
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie2 },
      payload: { id: channelId, config: { botToken: 'hacked' } },
    });

    expect(patchRes.statusCode).toBe(404);
  });
});

// ── P1-7: 채널 config JSON 파싱 실패 로깅 ────────────────────────────

describe('P1-7: 채널 config JSON 파싱 실패 시 건너뜀', () => {
  it('잘못된 config의 채널은 bindings에서 제외됨', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    await seedAgentsForOrg(orgId);

    // 정상 채널 생성
    await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { channel_type: 'telegram', config: { botToken: 'valid' } },
    });

    // DB에 직접 잘못된 JSON config 삽입
    const pool = getPool();
    await pool.query(
      `INSERT INTO openclaw_channels(id,org_id,channel_type,config,enabled)
       VALUES($1,$2,$3,$4,$5)`,
      [newId(), orgId, 'discord', 'NOT_VALID_JSON{{{', true],
    );

    // config 생성 — 잘못된 채널은 건너뛰어야 함
    const res = await app.inject({
      method: 'GET',
      url: '/api/openclaw/config',
      headers: { Cookie: cookie },
    });

    expect(res.statusCode).toBe(200);
    const config = res.json().config;

    // telegram은 포함, discord는 제외
    expect(config.channels?.telegram).toBeDefined();
    expect(config.channels?.discord).toBeUndefined();

    // telegram binding은 있지만 discord binding은 없음
    const discordBinding = config.bindings.find(
      (b: { match: { channel: string } }) => b.match.channel === 'discord',
    );
    expect(discordBinding).toBeUndefined();
  });
});

// ── P1-8: 채널 DELETE 후 stored config 무효화 ────────────────────────

describe('P1-8: 채널 DELETE 후 stored config 무효화', () => {
  it('채널 삭제 시 openclaw_configs도 삭제됨', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    await seedAgentsForOrg(orgId);

    // 채널 생성
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { channel_type: 'telegram', config: { botToken: 'x' } },
    });
    const channelId = createRes.json().id;

    // sync 실행 → config 저장됨
    await app.inject({
      method: 'POST',
      url: '/api/openclaw/sync',
      headers: { Cookie: cookie },
    });

    // config 존재 확인
    let stored = await q1<{ id: string }>(
      'SELECT id FROM openclaw_configs WHERE org_id = $1', [orgId],
    );
    expect(stored).toBeDefined();

    // 채널 삭제
    await app.inject({
      method: 'DELETE',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { id: channelId },
    });

    // config 무효화 확인
    stored = await q1<{ id: string }>(
      'SELECT id FROM openclaw_configs WHERE org_id = $1', [orgId],
    );
    expect(stored).toBeUndefined();
  });
});

// ── P2-13: toAgentId() 충돌 방지 ────────────────────────────────────

describe('P2-13: agentId 충돌 방지', () => {
  it('같은 이름으로 변환되는 팀이 있을 때 suffix가 붙음', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });

    const pool = getPool();
    const divId = newId();
    const wsId = newId();
    const teamId1 = newId();
    const teamId2 = newId();

    await pool.query(
      'INSERT INTO divisions(id,org_id,name,ws_path) VALUES($1,$2,$3,$4)',
      [divId, orgId, 'Div', TEST_DIR],
    );
    await pool.query(
      'INSERT INTO workspaces(id,org_id,division_id,name,path) VALUES($1,$2,$3,$4,$5)',
      [wsId, orgId, divId, 'WS', path.join(TEST_DIR, 'ws')],
    );

    // "Dev-Team"과 "Dev Team" → 둘 다 "dev-team"으로 변환
    await pool.query(
      'INSERT INTO teams(id,org_id,workspace_id,name,description) VALUES($1,$2,$3,$4,$5)',
      [teamId1, orgId, wsId, 'Dev-Team', 'First'],
    );
    await pool.query(
      'INSERT INTO teams(id,org_id,workspace_id,name,description) VALUES($1,$2,$3,$4,$5)',
      [teamId2, orgId, wsId, 'Dev Team', 'Second'],
    );

    // 각 팀에 리드 에이전트 추가
    await pool.query(
      `INSERT INTO agents(id,org_id,workspace_id,team_id,org_level,is_lead,name,soul,command_name,harness_pattern,model)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [newId(), orgId, wsId, teamId1, 'team', true, 'Lead1', 'soul', null, 'orchestrator', 'claude-sonnet-4-6'],
    );
    await pool.query(
      `INSERT INTO agents(id,org_id,workspace_id,team_id,org_level,is_lead,name,soul,command_name,harness_pattern,model)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [newId(), orgId, wsId, teamId2, 'team', true, 'Lead2', 'soul', null, 'orchestrator', 'claude-sonnet-4-6'],
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/openclaw/config',
      headers: { Cookie: cookie },
    });

    expect(res.statusCode).toBe(200);
    const agentList = res.json().config.agents.list;

    // orchestrator를 제외한 에이전트 id 목록
    const ids = agentList.map((a: { id: string }) => a.id).filter((id: string) => id !== 'orchestrator');

    // 중복 없음을 확인
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);

    // 하나는 "dev-team", 다른 하나는 "dev-team-2"
    expect(ids).toContain('dev-team');
    expect(ids).toContain('dev-team-2');
  });
});

// ── P0-2: materializeOpenClawWorkspace sync lock ─────────────────────

describe('P0-2: sync lock으로 동시 호출 방지', () => {
  it('동시 sync 호출이 순차 처리됨', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    await seedAgentsForOrg(orgId);

    // 동시에 3번 sync 요청
    const results = await Promise.all([
      app.inject({ method: 'POST', url: '/api/openclaw/sync', headers: { Cookie: cookie } }),
      app.inject({ method: 'POST', url: '/api/openclaw/sync', headers: { Cookie: cookie } }),
      app.inject({ method: 'POST', url: '/api/openclaw/sync', headers: { Cookie: cookie } }),
    ]);

    // 모두 성공
    for (const res of results) {
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    }

    // 런타임 디렉토리가 정상 상태 (파일 소실 없음)
    const runtimeDir = results[0].json().runtimeDir;
    expect(fs.existsSync(path.join(runtimeDir, 'openclaw.json'))).toBe(true);

    // version은 3 (순차 실행되어 3번 증가)
    const row = await q1<{ version: number }>(
      'SELECT version FROM openclaw_configs WHERE org_id = $1', [orgId],
    );
    expect(row!.version).toBe(3);
  });
});

// ── P3-17: 채널 config 구조 검증 ────────────────────────────────────

describe('P3-17: POST 채널 config JSON 검증', () => {
  it('정상 config는 생성됨', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: {
        channel_type: 'telegram',
        config: { botToken: 'test', allowedChatIds: [123] },
      },
    });

    expect(res.statusCode).toBe(201);
  });

  it('빈 config도 허용됨', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/openclaw/channels',
      headers: { Cookie: cookie },
      payload: { channel_type: 'telegram' },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.json().config)).toEqual({});
  });
});
