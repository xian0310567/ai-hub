/**
 * Integration tests for /api/openclaw (OpenClaw 워크스페이스 동기화)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { buildApp } from './helpers/app.js';
import { clearDb, seedUser, q1, newId } from './helpers/db.js';
import { getPool } from '../db/pool.js';

const TEST_DIR = path.join(os.tmpdir(), 'aihub-openclaw-test');

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
  // 런타임 디렉토리 정리
  const runtimeDir = path.join(TEST_DIR, 'openclaw-runtime');
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});

// ── 헬퍼 ──────────────────────────────────────────────────────────────

async function seedAgents(orgId: string, cookie: string) {
  // 워크스페이스 + 팀 생성
  const divId = newId();
  const wsId = newId();
  const teamId = newId();
  const pool = getPool();

  await pool.query(
    'INSERT INTO divisions(id,org_id,name,ws_path) VALUES($1,$2,$3,$4)',
    [divId, orgId, 'Dev Division', TEST_DIR],
  );
  await pool.query(
    'INSERT INTO workspaces(id,org_id,division_id,name,path) VALUES($1,$2,$3,$4,$5)',
    [wsId, orgId, divId, 'Dev WS', path.join(TEST_DIR, 'ws')],
  );
  await pool.query(
    'INSERT INTO teams(id,org_id,workspace_id,name,description) VALUES($1,$2,$3,$4,$5)',
    [teamId, orgId, wsId, '개발팀', '개발 업무 수행'],
  );

  // 에이전트 생성: 팀장 + 팀원 2명
  const leadId = newId();
  const dev1Id = newId();
  const dev2Id = newId();

  await pool.query(
    `INSERT INTO agents(id,org_id,workspace_id,team_id,org_level,is_lead,name,soul,command_name,harness_pattern,model)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [leadId, orgId, wsId, teamId, 'team', true, '개발팀장',
     '## 정체성\n개발팀장입니다.', '개발팀장', 'orchestrator', 'claude-sonnet-4-6'],
  );
  await pool.query(
    `INSERT INTO agents(id,org_id,workspace_id,team_id,org_level,is_lead,name,soul,command_name,harness_pattern,model)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [dev1Id, orgId, wsId, teamId, 'worker', false, 'BE개발자',
     '## 정체성\n백엔드 개발자입니다.', 'be개발자', 'single', 'claude-sonnet-4-6'],
  );
  await pool.query(
    `INSERT INTO agents(id,org_id,workspace_id,team_id,org_level,is_lead,name,soul,command_name,harness_pattern,model)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [dev2Id, orgId, wsId, teamId, 'worker', false, 'FE개발자',
     '## 정체성\n프론트엔드 개발자입니다.', 'fe개발자', 'single', 'claude-sonnet-4-6'],
  );

  return { teamId, wsId, divId, leadId, dev1Id, dev2Id };
}

// ── GET /api/openclaw/config ──────────────────────────────────────────

describe('GET /api/openclaw/config', () => {
  it('generates config from DB agents', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    await seedAgents(orgId, cookie);

    const res = await app.inject({
      method: 'GET',
      url: '/api/openclaw/config',
      headers: { Cookie: cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.config.agents.list).toBeDefined();
    expect(body.config.agents.list.length).toBeGreaterThanOrEqual(3); // orchestrator + team + members
  });

  it('generates orchestrator even with no agents', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/openclaw/config',
      headers: { Cookie: cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.config.agents.list.length).toBe(1);
    expect(body.config.agents.list[0].id).toBe('orchestrator');
    expect(body.config.agents.list[0].default).toBe(true);
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/openclaw/config',
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── POST /api/openclaw/sync ───────────────────────────────────────────

describe('POST /api/openclaw/sync', () => {
  it('materializes runtime files from DB', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    await seedAgents(orgId, cookie);

    const res = await app.inject({
      method: 'POST',
      url: '/api/openclaw/sync',
      headers: { Cookie: cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.agentCount).toBe(3);
    expect(body.runtimeDir).toContain('openclaw-runtime');

    // 파일이 실제로 생성되었는지 확인
    const runtimeDir = body.runtimeDir;
    expect(fs.existsSync(path.join(runtimeDir, 'openclaw.json'))).toBe(true);
    expect(fs.existsSync(path.join(runtimeDir, 'orchestrator', 'SOUL.md'))).toBe(true);

    // openclaw.json 내용 검증
    const config = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'openclaw.json'), 'utf8'));
    expect(config.agents.list.length).toBeGreaterThanOrEqual(3);
  });

  it('saves config to openclaw_configs table', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    await seedAgents(orgId, cookie);

    await app.inject({
      method: 'POST',
      url: '/api/openclaw/sync',
      headers: { Cookie: cookie },
    });

    const row = await q1<{ config: string; version: number }>(
      'SELECT config, version FROM openclaw_configs WHERE org_id = $1', [orgId],
    );
    expect(row).toBeDefined();
    expect(row!.version).toBe(1);

    const config = JSON.parse(row!.config);
    expect(config.agents.list).toBeDefined();
  });

  it('increments version on re-sync', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    await seedAgents(orgId, cookie);

    await app.inject({ method: 'POST', url: '/api/openclaw/sync', headers: { Cookie: cookie } });
    await app.inject({ method: 'POST', url: '/api/openclaw/sync', headers: { Cookie: cookie } });

    const row = await q1<{ version: number }>(
      'SELECT version FROM openclaw_configs WHERE org_id = $1', [orgId],
    );
    expect(row!.version).toBe(2);
  });

  it('member cannot sync (403)', async () => {
    const { cookie } = await seedUser({ role: 'member' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/openclaw/sync',
      headers: { Cookie: cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── GET /api/openclaw/stored ──────────────────────────────────────────

describe('GET /api/openclaw/stored', () => {
  it('returns 404 when no sync has happened', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/openclaw/stored',
      headers: { Cookie: cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns stored config after sync', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    await seedAgents(orgId, cookie);

    await app.inject({ method: 'POST', url: '/api/openclaw/sync', headers: { Cookie: cookie } });

    const res = await app.inject({
      method: 'GET',
      url: '/api/openclaw/stored',
      headers: { Cookie: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().version).toBe(1);
  });
});

// ── GET /api/openclaw/status ──────────────────────────────────────────

describe('GET /api/openclaw/status', () => {
  it('returns status with agent count', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    await seedAgents(orgId, cookie);

    const res = await app.inject({
      method: 'GET',
      url: '/api/openclaw/status',
      headers: { Cookie: cookie },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.totalAgents).toBe(3);
    expect(body.hasSyncedConfig).toBe(false);
  });

  it('shows synced status after sync', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    await seedAgents(orgId, cookie);

    await app.inject({ method: 'POST', url: '/api/openclaw/sync', headers: { Cookie: cookie } });

    const res = await app.inject({
      method: 'GET',
      url: '/api/openclaw/status',
      headers: { Cookie: cookie },
    });
    expect(res.json().hasSyncedConfig).toBe(true);
    expect(res.json().configVersion).toBe(1);
  });
});

// ── 오케스트레이터 SOUL 생성 검증 ────────────────────────────────────

describe('Orchestrator SOUL generation', () => {
  it('includes sessions_send documentation', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    await seedAgents(orgId, cookie);

    const res = await app.inject({
      method: 'POST',
      url: '/api/openclaw/sync',
      headers: { Cookie: cookie },
    });

    const runtimeDir = res.json().runtimeDir;
    const soul = fs.readFileSync(path.join(runtimeDir, 'orchestrator', 'SOUL.md'), 'utf8');

    expect(soul).toContain('sessions_send');
    expect(soul).toContain('CEO');
    expect(soul).toContain('개발팀');
  });

  it('generates agent .md files with correct format', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    await seedAgents(orgId, cookie);

    const res = await app.inject({
      method: 'POST',
      url: '/api/openclaw/sync',
      headers: { Cookie: cookie },
    });

    const runtimeDir = res.json().runtimeDir;
    const teamDir = path.join(runtimeDir, '개발팀');

    // 팀 디렉토리가 생성되었는지 확인
    expect(fs.existsSync(teamDir)).toBe(true);

    // .claude/agents/ 디렉토리에 에이전트 md 파일이 있는지 확인
    const agentsDir = path.join(teamDir, '.claude', 'agents');
    expect(fs.existsSync(agentsDir)).toBe(true);

    const files = fs.readdirSync(agentsDir);
    expect(files.length).toBeGreaterThanOrEqual(1);

    // 파일 내용에 frontmatter가 있는지 확인
    const firstFile = fs.readFileSync(path.join(agentsDir, files[0]), 'utf8');
    expect(firstFile).toContain('---');
    expect(firstFile).toContain('name:');
  });
});

// ── GET /api/openclaw/diff ───────────────────────────────────────────

describe('GET /api/openclaw/diff', () => {
  it('shows all agents as added when no stored config', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    await seedAgents(orgId, cookie);

    const res = await app.inject({
      method: 'GET',
      url: '/api/openclaw/diff',
      headers: { Cookie: cookie },
    });

    expect(res.statusCode).toBe(200);
    const { diff } = res.json();
    expect(diff.hasChanges).toBe(true);
    expect(diff.agents.added.length).toBeGreaterThanOrEqual(3);
    expect(diff.agents.removed).toHaveLength(0);
    expect(diff.agents.modified).toHaveLength(0);
  });

  it('shows no changes after sync', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    await seedAgents(orgId, cookie);

    // sync 실행
    await app.inject({ method: 'POST', url: '/api/openclaw/sync', headers: { Cookie: cookie } });

    const res = await app.inject({
      method: 'GET',
      url: '/api/openclaw/diff',
      headers: { Cookie: cookie },
    });

    const { diff } = res.json();
    expect(diff.hasChanges).toBe(false);
    expect(diff.agents.added).toHaveLength(0);
    expect(diff.agents.removed).toHaveLength(0);
    expect(diff.agents.modified).toHaveLength(0);
    expect(diff.agents.unchanged.length).toBeGreaterThanOrEqual(3);
  });

  it('detects agent modifications after sync', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    const { leadId } = await seedAgents(orgId, cookie);

    // 최초 sync
    await app.inject({ method: 'POST', url: '/api/openclaw/sync', headers: { Cookie: cookie } });

    // 에이전트 모델 변경
    await getPool().query(
      'UPDATE agents SET model = $1 WHERE id = $2',
      ['claude-opus-4-6', leadId],
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/openclaw/diff',
      headers: { Cookie: cookie },
    });

    const { diff } = res.json();
    expect(diff.hasChanges).toBe(true);
    expect(diff.agents.modified.length).toBeGreaterThanOrEqual(1);
    // 모델 변경이 감지됨
    const modelChange = diff.agents.modified.find(
      (m: { agentId: string; changes: Array<{ field: string }> }) =>
        m.changes.some((c: { field: string }) => c.field === 'model'),
    );
    expect(modelChange).toBeDefined();
  });

  it('detects added agents after sync', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    const { wsId, teamId } = await seedAgents(orgId, cookie);

    await app.inject({ method: 'POST', url: '/api/openclaw/sync', headers: { Cookie: cookie } });

    // 새 에이전트 추가
    await getPool().query(
      `INSERT INTO agents(id,org_id,workspace_id,team_id,org_level,is_lead,name,soul,command_name,harness_pattern,model)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [newId(), orgId, wsId, teamId, 'worker', false, 'QA엔지니어', '테스트 담당', 'qa', 'single', 'claude-sonnet-4-6'],
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/openclaw/diff',
      headers: { Cookie: cookie },
    });

    const { diff } = res.json();
    expect(diff.hasChanges).toBe(true);
    expect(diff.agents.added.length).toBeGreaterThanOrEqual(1);
  });
});

// ── POST /api/openclaw/selective-sync ────────────────────────────────

describe('POST /api/openclaw/selective-sync', () => {
  it('returns diff alongside sync result', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    await seedAgents(orgId, cookie);

    const res = await app.inject({
      method: 'POST',
      url: '/api/openclaw/selective-sync',
      headers: { Cookie: cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.diff).toBeDefined();
    expect(body.diff.hasChanges).toBe(true);
    expect(body.agentCount).toBe(3);
    expect(body.config).toBeDefined();
  });

  it('no-op selective-sync when nothing changed', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    await seedAgents(orgId, cookie);

    // 최초 full sync
    await app.inject({ method: 'POST', url: '/api/openclaw/sync', headers: { Cookie: cookie } });

    // selective sync — 변경 없음
    const res = await app.inject({
      method: 'POST',
      url: '/api/openclaw/selective-sync',
      headers: { Cookie: cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.diff.hasChanges).toBe(false);
  });

  it('member cannot selective-sync (403)', async () => {
    const { cookie } = await seedUser({ role: 'member' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/openclaw/selective-sync',
      headers: { Cookie: cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
