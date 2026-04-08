/**
 * Integration tests for /api/hosts (register / heartbeat / list)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './helpers/app.js';
import { clearDb, seedUser, q1 } from './helpers/db.js';
import { getPool } from '../db/pool.js';

let app: FastifyInstance;

beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await clearDb(); });

describe('POST /api/hosts/register', () => {
  it('registers a new host and returns 201', async () => {
    const { cookie } = await seedUser();
    const res = await app.inject({
      method: 'POST',
      url: '/api/hosts/register',
      headers: { Cookie: cookie },
      payload: { name: 'my-laptop' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBeDefined();
  });

  it('re-registers existing host: sets status to idle and returns 200', async () => {
    const { cookie, userId } = await seedUser();

    const first = await app.inject({
      method: 'POST',
      url: '/api/hosts/register',
      headers: { Cookie: cookie },
      payload: { name: 'laptop' },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/api/hosts/register',
      headers: { Cookie: cookie },
      payload: { name: 'laptop' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);

    const rows = await getPool().query(
      'SELECT count(*) as c FROM hosts WHERE user_id = $1 AND name = $2',
      [userId, 'laptop'],
    );
    expect(Number(rows.rows[0].c)).toBe(1);
  });

  it('returns 400 when name is missing', async () => {
    const { cookie } = await seedUser();
    const res = await app.inject({
      method: 'POST',
      url: '/api/hosts/register',
      headers: { Cookie: cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/hosts/register',
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/hosts/:hostId/heartbeat', () => {
  it('updates status and last_heartbeat', async () => {
    const { cookie } = await seedUser();

    const regRes = await app.inject({
      method: 'POST',
      url: '/api/hosts/register',
      headers: { Cookie: cookie },
      payload: { name: 'pc1' },
    });
    const hostId = regRes.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/hosts/${hostId}/heartbeat`,
      headers: { Cookie: cookie },
      payload: { status: 'busy' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });

    const row = await q1<{ status: string }>('SELECT status FROM hosts WHERE id = $1', [hostId]);
    expect(row?.status).toBe('busy');
  });

  it('returns 404 for unknown host', async () => {
    const { cookie } = await seedUser();
    const res = await app.inject({
      method: 'POST',
      url: '/api/hosts/nonexistent/heartbeat',
      headers: { Cookie: cookie },
      payload: { status: 'idle' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/hosts — list org hosts', () => {
  it('returns all hosts for the org', async () => {
    const { cookie } = await seedUser();
    await app.inject({ method: 'POST', url: '/api/hosts/register', headers: { Cookie: cookie }, payload: { name: 'host-a' } });
    await app.inject({ method: 'POST', url: '/api/hosts/register', headers: { Cookie: cookie }, payload: { name: 'host-b' } });

    const res = await app.inject({ method: 'GET', url: '/api/hosts', headers: { Cookie: cookie } });
    expect(res.statusCode).toBe(200);
    const list = res.json() as { name: string }[];
    expect(list.length).toBe(2);
    expect(list.map((h) => h.name)).toContain('host-a');
    expect(list.map((h) => h.name)).toContain('host-b');
  });

  it('marks stale hosts as offline', async () => {
    const { cookie } = await seedUser();
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/hosts/register',
      headers: { Cookie: cookie },
      payload: { name: 'stale-host' },
    });
    const hostId = regRes.json().id;

    // Set heartbeat to 10 minutes ago (stale)
    const staleTs = Math.floor(Date.now() / 1000) - 600;
    await getPool().query(
      'UPDATE hosts SET last_heartbeat = $1, status = $2 WHERE id = $3',
      [staleTs, 'idle', hostId],
    );

    const res = await app.inject({ method: 'GET', url: '/api/hosts', headers: { Cookie: cookie } });
    expect(res.statusCode).toBe(200);
    const hosts = res.json() as { id: string; status: string }[];
    const stale = hosts.find((h) => h.id === hostId);
    expect(stale?.status).toBe('offline');
  });
});
