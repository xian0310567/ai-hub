import { q1, now } from './pool.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

export interface SessionUser {
  userId: string;
  username: string;
  orgId: string;
  role: string;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<SessionUser> {
  const sessionId = req.cookies?.session;
  if (!sessionId) {
    reply.code(401).send({ error: 'Unauthorized' });
    throw new Error('Unauthorized');
  }

  const row = await q1<{ user_id: string; username: string; org_id: string; role: string }>(`
    SELECT s.user_id, u.username, s.org_id, om.role
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    JOIN org_members om ON om.user_id = u.id AND om.org_id = s.org_id
    WHERE s.id = ? AND s.expires_at > ?
    LIMIT 1
  `, [sessionId, now()]);

  if (!row) {
    reply.code(401).send({ error: 'Session expired' });
    throw new Error('Unauthorized');
  }

  if (!row.org_id) {
    reply.code(403).send({ error: '워크스페이스가 지정되지 않은 세션입니다. 다시 로그인해주세요.' });
    throw new Error('No org');
  }

  return {
    userId: row.user_id,
    username: row.username,
    orgId: row.org_id,
    role: row.role,
  };
}

export function requireRole(user: SessionUser, roles: string[], reply: FastifyReply): boolean {
  if (!roles.includes(user.role)) {
    reply.code(403).send({ error: 'Forbidden' });
    return false;
  }
  return true;
}
