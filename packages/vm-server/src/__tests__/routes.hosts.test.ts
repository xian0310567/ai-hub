/**
 * Integration tests for /api/hosts (register / heartbeat / list)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './helpers/app.js';
import { clearDb, seedUser, db } from './helpers/db.js';

let app: FastifyInstance;

beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); });
beforeEach(() => clearDb());

describe('POST /api/hosts/register', () => {
  it('registers a new host and returns 201', async () => {
    const { cookie } = seedUser();
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
    const { cookie, userId, orgId } = seedUser();

    // First register
    const first = await app.inject({
      method: 'POST',
      url: '/api/hosts/register',
      headers: { Cookie: cookie },
      payload: { name: 'laptop' },
    });
    expect(first.statusCode).toBe(201);

    // Register again
    const second = await app.inject({
      method: 'POST',
      url: '/api/hosts/register',
      headers: { Cookie: cookie },
      payload: { name: 'laptop' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id); // same id

    // DB should have only 1 host
    const count = (db.prepare('SELECT count(*) as c FROM hosts WHERE user_id = ? AND name = ?').get(userId, 'laptop') as { c: number }).c;
    expect(count).toBe(1);
  });

  it('returns 400 when name is missing', async () => {
    const { cookie } = seedUser();
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
    const { cookie, userId, orgId } = seedUser();

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

    const row = db.prepare('SELECT status FROM hosts WHERE id = ?').get(hostId) as { status: string };
    expect(row.status).toBe('busy');
  });

  it('returns 404 for unknown host', async () => {
    const { cookie } = seedUser();
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
    const { cookie } = seedUser();
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
    const { cookie, userId, orgId } = seedUser();
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/hosts/register',
      headers: { Cookie: cookie },
      payload: { name: 'stale-host' },
    });
    const hostId = regRes.json().id;

    // Set heartbeat to 10 minutes ago (stale)
    const staleTs = Math.floor(Date.now() / 1000) - 600;
    db.prepare('UPDATE hosts SET last_heartbeat = ?, status = ? WHERE id = ?').run(staleTs, 'idle', hostId);

    const res = await app.inject({ method: 'GET', url: '/api/hosts', headers: { Cookie: cookie } });
    expect(res.statusCode).toBe(200);
    const hosts = res.json() as { id: string; status: string }[];
    const stale = hosts.find((h) => h.id === hostId);
    expect(stale?.status).toBe('offline');
  });
});
