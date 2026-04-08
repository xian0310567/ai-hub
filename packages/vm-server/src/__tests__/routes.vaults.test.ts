/**
 * Integration tests for /api/vaults (CRUD + encryption + RBAC)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './helpers/app.js';
import { clearDb, seedUser, q1 } from './helpers/db.js';

let app: FastifyInstance;

beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await clearDb(); });

async function createVault(cookie: string, name = 'Test Vault', scope = 'org') {
  return app.inject({
    method: 'POST',
    url: '/api/vaults',
    headers: { Cookie: cookie },
    payload: { name, scope },
  });
}

describe('POST /api/vaults — create vault', () => {
  it('org_admin can create a vault (201)', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });
    const res = await createVault(cookie);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('Test Vault');
    expect(body.scope).toBe('org');
    expect(body.id).toBeDefined();
  });

  it('team_admin can create a vault (201)', async () => {
    const { cookie } = await seedUser({ role: 'team_admin' });
    const res = await createVault(cookie, 'Team Vault');
    expect(res.statusCode).toBe(201);
  });

  it('member is forbidden (403)', async () => {
    const { cookie } = await seedUser({ role: 'member' });
    const res = await createVault(cookie);
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 when name is missing', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/vaults',
      headers: { Cookie: cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/name/i);
  });

  it('returns 401 without session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/vaults', payload: { name: 'v' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/vaults — list vaults', () => {
  it('returns only vaults for the user org', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });
    await createVault(cookie, 'Vault A');
    await createVault(cookie, 'Vault B');

    const res = await app.inject({ method: 'GET', url: '/api/vaults', headers: { Cookie: cookie } });
    expect(res.statusCode).toBe(200);
    const list = res.json() as { name: string }[];
    expect(list.length).toBe(2);
    expect(list.map((v) => v.name)).toContain('Vault A');
  });
});

describe('POST /api/vaults/:id/secrets — add secret', () => {
  it('encrypts and stores a secret', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });
    const vaultRes = await createVault(cookie);
    const vaultId = vaultRes.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/secrets`,
      headers: { Cookie: cookie },
      payload: { key_name: 'API_KEY', value: 'super-secret-value' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ok: true, key_name: 'API_KEY' });

    // Raw DB row should have encrypted data, not plaintext
    const row = await q1<{ encrypted_value: string; key_name: string }>(
      'SELECT encrypted_value, key_name FROM vault_secrets WHERE vault_id = $1 AND key_name = $2',
      [vaultId, 'API_KEY'],
    );
    expect(row).toBeDefined();
    expect(row!.encrypted_value).not.toBe('super-secret-value');
  });

  it('member cannot add secrets (403)', async () => {
    const { cookie: adminCookie } = await seedUser({ role: 'org_admin' });
    const { cookie: memberCookie } = await seedUser({ role: 'member', username: 'member1' });
    const vaultRes = await createVault(adminCookie);
    const vaultId = vaultRes.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/secrets`,
      headers: { Cookie: memberCookie },
      payload: { key_name: 'K', value: 'v' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('upserts existing key_name', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });
    const vaultRes = await createVault(cookie);
    const vaultId = vaultRes.json().id;

    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/secrets`,
      headers: { Cookie: cookie },
      payload: { key_name: 'TOKEN', value: 'v1' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/secrets`,
      headers: { Cookie: cookie },
      payload: { key_name: 'TOKEN', value: 'v2' },
    });

    const row = await q1<{ c: string }>(
      'SELECT count(*) as c FROM vault_secrets WHERE vault_id = $1 AND key_name = $2',
      [vaultId, 'TOKEN'],
    );
    expect(Number(row!.c)).toBe(1);
  });
});

describe('GET /api/vaults/:id/secrets — list secrets (no values)', () => {
  it('returns key names but no encrypted values', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });
    const vaultRes = await createVault(cookie);
    const vaultId = vaultRes.json().id;

    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/secrets`,
      headers: { Cookie: cookie },
      payload: { key_name: 'MY_KEY', value: 'my-value' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/secrets`,
      headers: { Cookie: cookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as { key_name: string; encrypted_value?: string }[];
    expect(list.length).toBe(1);
    expect(list[0].key_name).toBe('MY_KEY');
    expect(list[0].encrypted_value).toBeUndefined();
  });
});

describe('POST /api/vaults/:id/lease — decrypt secrets', () => {
  it('decrypts and returns plaintext values', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });
    const vaultRes = await createVault(cookie);
    const vaultId = vaultRes.json().id;

    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/secrets`,
      headers: { Cookie: cookie },
      payload: { key_name: 'SECRET', value: 'my-plaintext' },
    });

    const leaseRes = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/lease`,
      headers: { Cookie: cookie },
      payload: { task_id: 'task-1', key_names: ['SECRET'] },
    });
    expect(leaseRes.statusCode).toBe(200);
    expect(leaseRes.json().secrets.SECRET).toBe('my-plaintext');
  });

  it('creates an audit log entry on lease', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });
    const vaultRes = await createVault(cookie);
    const vaultId = vaultRes.json().id;
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/secrets`,
      headers: { Cookie: cookie },
      payload: { key_name: 'K', value: 'v' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/lease`,
      headers: { Cookie: cookie },
      payload: { task_id: 'task-xyz', key_names: ['K'] },
    });

    const log = await q1(
      `SELECT * FROM audit_logs WHERE action = 'vault.lease' AND resource_id = $1`,
      [vaultId],
    );
    expect(log).toBeDefined();
  });
});

describe('PATCH /api/vaults/:id — update vault metadata', () => {
  it('updates name and description', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });
    const vaultRes = await createVault(cookie, 'OldName');
    const vaultId = vaultRes.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/vaults/${vaultId}`,
      headers: { Cookie: cookie },
      payload: { name: 'NewName', description: 'updated desc' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('NewName');
    expect(res.json().description).toBe('updated desc');
  });

  it('member cannot update (403)', async () => {
    const { cookie: adminCookie } = await seedUser({ role: 'org_admin' });
    const { cookie: memberCookie } = await seedUser({ role: 'member', username: 'mem2' });
    const vaultRes = await createVault(adminCookie);
    const vaultId = vaultRes.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/vaults/${vaultId}`,
      headers: { Cookie: memberCookie },
      payload: { name: 'Hacked' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /api/vaults/:id — delete vault', () => {
  it('org_admin can delete a vault', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });
    const vaultRes = await createVault(cookie, 'ToDelete');
    const vaultId = vaultRes.json().id;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/vaults/${vaultId}`,
      headers: { Cookie: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });

    const row = await q1('SELECT id FROM vaults WHERE id = $1', [vaultId]);
    expect(row).toBeUndefined();
  });

  it('team_admin cannot delete a vault (403)', async () => {
    const { cookie: adminCookie } = await seedUser({ role: 'org_admin' });
    const { cookie: teamAdminCookie } = await seedUser({ role: 'team_admin', username: 'tadmin' });
    const vaultRes = await createVault(adminCookie);
    const vaultId = vaultRes.json().id;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/vaults/${vaultId}`,
      headers: { Cookie: teamAdminCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /api/vaults/:id/secrets/:secretId', () => {
  it('deletes a specific secret', async () => {
    const { cookie } = await seedUser({ role: 'org_admin' });
    const vaultRes = await createVault(cookie);
    const vaultId = vaultRes.json().id;

    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/secrets`,
      headers: { Cookie: cookie },
      payload: { key_name: 'DEL_KEY', value: 'val' },
    });

    const secretRow = await q1<{ id: string }>(
      'SELECT id FROM vault_secrets WHERE vault_id = $1 AND key_name = $2',
      [vaultId, 'DEL_KEY'],
    );

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/vaults/${vaultId}/secrets/${secretRow!.id}`,
      headers: { Cookie: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });

    const row = await q1('SELECT id FROM vault_secrets WHERE id = $1', [secretRow!.id]);
    expect(row).toBeUndefined();
  });
});

// ── Phase 3: personal_meta vault 테스트 ────────────────────────────────

describe('personal_meta vault — 생성 및 RBAC', () => {
  it('member도 personal_meta vault 생성 가능 (201)', async () => {
    const { cookie } = await seedUser({ role: 'member', username: 'mem-personal' });
    const res = await createVault(cookie, 'My Personal Keys', 'personal_meta');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.scope).toBe('personal_meta');
    expect(body.owner_user_id).toBeDefined();
  });

  it('owner_user_id가 본인으로 설정됨', async () => {
    const { cookie, userId } = await seedUser({ role: 'member', username: 'mem-owner' });
    const res = await createVault(cookie, 'Personal', 'personal_meta');
    expect(res.json().owner_user_id).toBe(userId);
  });

  it('목록 조회 시 본인 personal vault만 포함', async () => {
    const { cookie: c1, userId: u1 } = await seedUser({ role: 'member', username: 'user1' });
    const { cookie: c2 } = await seedUser({ role: 'member', username: 'user2' });

    await createVault(c1, 'User1 Personal', 'personal_meta');
    await createVault(c2, 'User2 Personal', 'personal_meta');

    const res = await app.inject({ method: 'GET', url: '/api/vaults', headers: { Cookie: c1 } });
    const list = res.json() as { scope: string; owner_user_id?: string }[];
    const personalInList = list.filter(v => v.scope === 'personal_meta');
    expect(personalInList.every(v => v.owner_user_id === u1)).toBe(true);
  });
});

describe('personal_meta vault — 시크릿 등록 (key_name만, 값 없음)', () => {
  it('owner가 key_name 등록 시 placeholder 저장 (201)', async () => {
    const { cookie } = await seedUser({ role: 'member', username: 'pvowner' });
    const vaultRes = await createVault(cookie, 'PV', 'personal_meta');
    const vaultId = vaultRes.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/secrets`,
      headers: { Cookie: cookie },
      payload: { key_name: 'MY_TOKEN' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ok: true, key_name: 'MY_TOKEN' });

    const row = await q1<{ encrypted_value: string }>(
      'SELECT encrypted_value FROM vault_secrets WHERE vault_id = $1 AND key_name = $2',
      [vaultId, 'MY_TOKEN'],
    );
    expect(row).toBeDefined();
    expect(row!.encrypted_value).toBe('__personal__');
  });

  it('다른 사용자가 personal vault에 추가 불가 (403)', async () => {
    const { cookie: ownerCookie } = await seedUser({ role: 'member', username: 'pv-o' });
    const { cookie: otherCookie } = await seedUser({ role: 'member', username: 'pv-x' });
    const vaultRes = await createVault(ownerCookie, 'PV', 'personal_meta');
    const vaultId = vaultRes.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/secrets`,
      headers: { Cookie: otherCookie },
      payload: { key_name: 'K' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('audit log 기록: vault.personal.key_registered', async () => {
    const { cookie } = await seedUser({ role: 'member', username: 'pv-audit' });
    const vaultRes = await createVault(cookie, 'PV', 'personal_meta');
    const vaultId = vaultRes.json().id;

    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/secrets`,
      headers: { Cookie: cookie },
      payload: { key_name: 'AUDIT_KEY' },
    });

    const log = await q1(
      `SELECT * FROM audit_logs WHERE action = 'vault.personal.key_registered' AND resource_id = $1`,
      [vaultId],
    );
    expect(log).toBeDefined();
  });
});

describe('personal_meta vault — Lease 요청 거부', () => {
  it('personal_meta vault lease → 403', async () => {
    const { cookie } = await seedUser({ role: 'member', username: 'pv-lease' });
    const vaultRes = await createVault(cookie, 'PV', 'personal_meta');
    const vaultId = vaultRes.json().id;

    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/secrets`,
      headers: { Cookie: cookie },
      payload: { key_name: 'K' },
    });

    const leaseRes = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/lease`,
      headers: { Cookie: cookie },
      payload: { task_id: 't1', key_names: ['K'] },
    });
    expect(leaseRes.statusCode).toBe(403);
    expect(leaseRes.json().error).toMatch(/personal/i);
  });
});
