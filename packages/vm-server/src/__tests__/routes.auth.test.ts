/**
 * Integration tests for /api/auth routes (signup / signin / signout / me)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './helpers/app.js';
import { clearDb, seedUser, db } from './helpers/db.js';

let app: FastifyInstance;

beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); });
beforeEach(() => clearDb());

describe('POST /api/auth/signup', () => {
  it('creates a user and returns 201', async () => {
    // Need an org first
    seedUser(); clearDb();
    // re-seed org only
    const { db: _db, newId } = await import('../db/schema.js');
    const orgId = newId();
    _db.prepare('INSERT INTO organizations(id,name,slug) VALUES(?,?,?)').run(orgId, 'Test', 'testorg');

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { username: 'newuser', password: 'password123', orgSlug: 'testorg' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('returns 400 for username too short', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { username: 'ab', password: 'password123' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Username/);
  });

  it('returns 400 for password too short', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { username: 'validname', password: '123' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Password/);
  });

  it('returns 409 for duplicate username', async () => {
    const { orgId } = seedUser({ username: 'dupuser' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { username: 'dupuser', password: 'password123' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/taken/i);
  });
});

describe('POST /api/auth/signin', () => {
  it('returns 200 with session cookie on valid credentials', async () => {
    seedUser({ username: 'alice', password: 'mypassword' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signin',
      payload: { username: 'alice', password: 'mypassword' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(res.headers['set-cookie']).toBeDefined();
    const cookie = Array.isArray(res.headers['set-cookie'])
      ? res.headers['set-cookie'].join(',')
      : res.headers['set-cookie'] as string;
    expect(cookie).toContain('session=');
  });

  it('returns 401 for wrong password', async () => {
    seedUser({ username: 'bob', password: 'rightpass' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signin',
      payload: { username: 'bob', password: 'wrongpass' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/credentials/i);
  });

  it('returns 401 for unknown user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signin',
      payload: { username: 'nobody', password: 'password123' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('returns user info for valid session', async () => {
    const { cookie, userId } = seedUser({ username: 'myuser' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { Cookie: cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.username).toBe('myuser');
    expect(body.id).toBe(userId);
    expect(Array.isArray(body.orgs)).toBe(true);
    expect(body.orgs.length).toBeGreaterThan(0);
  });

  it('returns 401 with no session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/auth/signout', () => {
  it('deletes session and clears cookie', async () => {
    const { cookie, sessionId } = seedUser({ username: 'signoutuser' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signout',
      headers: { Cookie: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });

    // Session should be deleted
    const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    expect(row).toBeUndefined();
  });
});
