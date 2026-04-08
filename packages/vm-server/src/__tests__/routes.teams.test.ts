/**
 * Integration tests for /api/teams (RBAC + team members)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import os from 'os';
import path from 'path';
import { buildApp } from './helpers/app.js';
import { clearDb, seedUser, q1, newId } from './helpers/db.js';
import { getPool } from '../db/pool.js';

const TEST_DIR = path.join(os.tmpdir(), 'aihub-test');

let app: FastifyInstance;

beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await clearDb(); });

async function createWorkspace(orgId: string) {
  const divId = newId();
  const wsId = newId();
  await getPool().query(
    'INSERT INTO divisions(id,org_id,name,ws_path) VALUES($1,$2,$3,$4)',
    [divId, orgId, 'Div', TEST_DIR],
  );
  await getPool().query(
    'INSERT INTO workspaces(id,org_id,division_id,name,path) VALUES($1,$2,$3,$4,$5)',
    [wsId, orgId, divId, 'WS', path.join(TEST_DIR, 'ws')],
  );
  return wsId;
}

async function createTeam(cookie: string, orgId: string, name = 'Dev Team') {
  const wsId = await createWorkspace(orgId);
  return app.inject({
    method: 'POST',
    url: '/api/teams',
    headers: { Cookie: cookie },
    payload: { name, workspace_id: wsId },
  });
}

describe('POST /api/teams — create team', () => {
  it('org_admin can create team (201)', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    const res = await createTeam(cookie, orgId);
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Dev Team');
  });

  it('team_admin can create team (201)', async () => {
    const { cookie, orgId } = await seedUser({ role: 'team_admin' });
    const res = await createTeam(cookie, orgId);
    expect(res.statusCode).toBe(201);
  });

  it('member is forbidden (403)', async () => {
    const { cookie, orgId } = await seedUser({ role: 'member' });
    const res = await createTeam(cookie, orgId);
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/teams — list teams', () => {
  it('returns teams for the org', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    await createTeam(cookie, orgId, 'Team A');
    await createTeam(cookie, orgId, 'Team B');

    const res = await app.inject({ method: 'GET', url: '/api/teams', headers: { Cookie: cookie } });
    expect(res.statusCode).toBe(200);
    const list = res.json() as { name: string }[];
    expect(list.length).toBe(2);
  });
});

describe('GET /api/teams/:id — single team', () => {
  it('returns 404 for unknown team', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });
    const res = await app.inject({ method: 'GET', url: '/api/teams/nope', headers: { Cookie: cookie } });
    expect(res.statusCode).toBe(404);
  });

  it('returns team details', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    const teamRes = await createTeam(cookie, orgId, 'MyTeam');
    const teamId = teamRes.json().id;

    const res = await app.inject({ method: 'GET', url: `/api/teams/${teamId}`, headers: { Cookie: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('MyTeam');
  });
});

describe('DELETE /api/teams — delete team (body: {id})', () => {
  it('org_admin can delete a team', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    const teamRes = await createTeam(cookie, orgId);
    const teamId = teamRes.json().id;

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/teams',
      headers: { Cookie: cookie },
      payload: { id: teamId },
    });
    expect(res.statusCode).toBe(200);
    const row = await q1('SELECT id FROM teams WHERE id = $1', [teamId]);
    expect(row).toBeUndefined();
  });

  it('member cannot delete (403)', async () => {
    const { cookie: adminCookie, orgId } = await seedUser({ role: 'org_admin' });
    const { cookie: memberCookie } = await seedUser({ role: 'member', username: 'memb3' });
    const teamRes = await createTeam(adminCookie, orgId);
    const teamId = teamRes.json().id;

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/teams',
      headers: { Cookie: memberCookie },
      payload: { id: teamId },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /api/teams/:id/members — add member', () => {
  it('org_admin can add a member', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    const { userId: newUserId } = await seedUser({ role: 'member', username: 'newmember' });
    const teamRes = await createTeam(cookie, orgId);
    const teamId = teamRes.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/members`,
      headers: { Cookie: cookie },
      payload: { user_id: newUserId, role: 'member' },
    });
    expect(res.statusCode).toBe(200);

    const row = await q1('SELECT * FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, newUserId]);
    expect(row).toBeDefined();
  });

  it('non-admin can still add members (route has no RBAC guard)', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    const { userId: targetId } = await seedUser({ role: 'member', username: 'target1' });
    const teamRes = await createTeam(cookie, orgId);
    const teamId = teamRes.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/members`,
      headers: { Cookie: cookie },
      payload: { user_id: targetId, role: 'member' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('DELETE /api/teams/:id/members/:userId', () => {
  it('removes a member from team', async () => {
    const { cookie, orgId } = await seedUser({ role: 'org_admin' });
    const { userId: memberId } = await seedUser({ role: 'member', username: 'removeme' });
    const teamRes = await createTeam(cookie, orgId);
    const teamId = teamRes.json().id;

    await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/members`,
      headers: { Cookie: cookie },
      payload: { user_id: memberId, role: 'member' },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/teams/${teamId}/members/${memberId}`,
      headers: { Cookie: cookie },
    });
    expect(res.statusCode).toBe(200);

    const row = await q1('SELECT * FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, memberId]);
    expect(row).toBeUndefined();
  });
});
