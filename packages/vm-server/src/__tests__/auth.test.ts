/**
 * Unit tests for requireAuth / requireRole middleware (db/auth.ts)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearDb, seedUser, db } from './helpers/db.js';
import { requireAuth, requireRole } from '../db/auth.js';
import { newId } from '../db/schema.js';

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

describe('requireAuth', () => {
  beforeEach(() => clearDb());

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
    const { userId } = seedUser();
    const expiredId = newId();
    const expiredAt = Math.floor(Date.now() / 1000) - 1; // already expired
    db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(expiredId, userId, expiredAt);

    const reply = mockReply();
    await expect(requireAuth(mockRequest(expiredId), reply as never)).rejects.toThrow('Unauthorized');
    expect(reply._status).toBe(401);
  });

  it('returns 403 when user has no org membership', async () => {
    // Create user without org
    const salt = '0'.repeat(32);
    const crypto = (await import('crypto')).default;
    const hash = crypto.scryptSync('password', salt, 64).toString('hex');
    const userId = newId();
    db.prepare('INSERT INTO users(id,username,password_hash) VALUES(?,?,?)').run(userId, 'noorg', `${salt}:${hash}`);

    const sessionId = newId();
    db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(
      sessionId, userId, Math.floor(Date.now() / 1000) + 86400
    );

    const reply = mockReply();
    await expect(requireAuth(mockRequest(sessionId), reply as never)).rejects.toThrow('No org');
    expect(reply._status).toBe(403);
  });

  it('returns SessionUser for valid session with org', async () => {
    const { sessionId, userId, orgId } = seedUser({ role: 'team_admin' });
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
