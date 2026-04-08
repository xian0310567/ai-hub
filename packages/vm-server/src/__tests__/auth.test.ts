/**
 * Unit tests for requireAuth / requireRole middleware (db/auth.ts)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { setupTestDb, clearDb, seedUser, q1, newId } from './helpers/db.js';
import { requireAuth, requireRole } from '../db/auth.js';
import { getPool } from '../db/pool.js';
import crypto from 'crypto';

// Minimal Fastify-like mock for reply
function mockReply() {
  const reply = {
    _status: 200,
    _body: null as unknown,
    code(n: number) { this._status = n; return this; },
    send(body: unknown) { this._body = body; return this; },
  };
  return reply;
}

// Minimal Fastify-like mock for request
function mockRequest(sessionId?: string) {
  return {
    cookies: sessionId ? { session: sessionId } : {},
  } as never;
}

beforeAll(async () => { await setupTestDb(); });
beforeEach(async () => { await clearDb(); });

describe('requireAuth', () => {
  it('returns 401 when no cookie', async () => {
    const reply = mockReply();
    await expect(requireAuth(mockRequest(), reply as never)).rejects.toThrow('Unauthorized');
    expect(reply._status).toBe(401);
  });

  it('returns 401 when session not found', async () => {
    const reply = mockReply();
    await expect(requireAuth(mockRequest('nonexistent'), reply as never)).rejects.toThrow('Unauthorized');
    expect(reply._status).toBe(401);
  });

  it('returns 401 when session is expired', async () => {
    const { userId } = await seedUser();
    const expiredId = newId();
    const expiredAt = Math.floor(Date.now() / 1000) - 1;
    await getPool().query(
      'INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,$3)',
      [expiredId, userId, expiredAt],
    );

    const reply = mockReply();
    await expect(requireAuth(mockRequest(expiredId), reply as never)).rejects.toThrow('Unauthorized');
    expect(reply._status).toBe(401);
  });

  it('returns 403 when user has no org membership', async () => {
    const salt = '0'.repeat(32);
    const hash = crypto.scryptSync('password', salt, 64).toString('hex');
    const userId = newId();
    await getPool().query(
      'INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)',
      [userId, 'noorg', `${salt}:${hash}`],
    );

    const sessionId = newId();
    await getPool().query(
      'INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,$3)',
      [sessionId, userId, Math.floor(Date.now() / 1000) + 86400],
    );

    const reply = mockReply();
    await expect(requireAuth(mockRequest(sessionId), reply as never)).rejects.toThrow('No org');
    expect(reply._status).toBe(403);
  });

  it('returns SessionUser for valid session with org', async () => {
    const { sessionId, userId, orgId } = await seedUser({ role: 'team_admin' });
    const reply = mockReply();
    const user = await requireAuth(mockRequest(sessionId), reply as never);

    expect(user.userId).toBe(userId);
    expect(user.orgId).toBe(orgId);
    expect(user.username).toBe('testuser');
    expect(user.role).toBe('team_admin');
  });
});

describe('requireRole', () => {
  it('returns true and sends nothing when role matches', () => {
    const reply = mockReply();
    const user = { userId: '1', username: 'u', orgId: 'o', role: 'org_admin' };
    const result = requireRole(user, ['org_admin', 'team_admin'], reply as never);
    expect(result).toBe(true);
    expect(reply._status).toBe(200);
    expect(reply._body).toBeNull();
  });

  it('returns false and sends 403 when role does not match', () => {
    const reply = mockReply();
    const user = { userId: '1', username: 'u', orgId: 'o', role: 'member' };
    const result = requireRole(user, ['org_admin', 'team_admin'], reply as never);
    expect(result).toBe(false);
    expect(reply._status).toBe(403);
    expect((reply._body as { error: string }).error).toBe('Forbidden');
  });
});
