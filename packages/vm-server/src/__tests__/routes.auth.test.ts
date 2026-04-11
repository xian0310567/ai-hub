/**
 * Integration tests for /api/auth routes (signup / signin / signout / me)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './helpers/app.js';
import { clearDb, seedUser, q1, newId } from './helpers/db.js';
import { getPool } from '../db/pool.js';

let app: FastifyInstance;

beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await clearDb(); });

describe('POST /api/auth/signup', () => {
  it('creates a user and returns 201', async () => {
    // Pre-seed org
    const orgId = newId();
    await getPool().query(
      'INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3)',
      [orgId, 'Test', 'testorg'],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { username: 'newuser', password: 'password123', workspace: 'testorg' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('returns 400 for username too short', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { username: 'ab', password: 'password123', workspace: 'testorg' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/아이디/);
  });

  it('returns 400 for password too short', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { username: 'validname', password: '123', workspace: 'testorg' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/비밀번호/);
  });

  it('returns 409 for duplicate username', async () => {
    await seedUser({ username: 'dupuser' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { username: 'dupuser', password: 'password123', workspace: 'testorg' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/이미 사용/);
  });
});

describe('POST /api/auth/signin', () => {
  it('returns 200 with session cookie on valid credentials', async () => {
    await seedUser({ username: 'alice', password: 'mypassword' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signin',
      payload: { username: 'alice', password: 'mypassword', workspace: 'testorg' },
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
    await seedUser({ username: 'bob', password: 'rightpass' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signin',
      payload: { username: 'bob', password: 'wrongpass', workspace: 'testorg' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/비밀번호/);
  });

  it('returns 401 for unknown user', async () => {
    // Pre-seed org so workspace resolution succeeds
    const orgId = newId();
    await getPool().query(
      'INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3)',
      [orgId, 'Test', 'testorg'],
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signin',
      payload: { username: 'nobody', password: 'password123', workspace: 'testorg' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('returns user info for valid session', async () => {
    const { cookie, userId } = await seedUser({ username: 'myuser' });

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
    const { cookie, sessionId } = await seedUser({ username: 'signoutuser' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signout',
      headers: { Cookie: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });

    // Session should be deleted
    const row = await q1('SELECT id FROM sessions WHERE id = $1', [sessionId]);
    expect(row).toBeUndefined();
  });
});
