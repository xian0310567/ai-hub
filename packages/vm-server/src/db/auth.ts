import { db } from './schema.js';
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

  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare(`
    SELECT s.user_id, u.username, om.org_id, om.role
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    LEFT JOIN org_members om ON om.user_id = u.id
    WHERE s.id = ? AND s.expires_at > ?
    LIMIT 1
  `).get(sessionId, now) as { user_id: string; username: string; org_id: string; role: string } | undefined;

  if (!row) {
    reply.code(401).send({ error: 'Session expired' });
    throw new Error('Unauthorized');
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
