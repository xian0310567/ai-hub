import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { db, newId } from '../db/schema.js';

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

export async function authRoutes(app: FastifyInstance) {
  // POST /api/auth/signup
  app.post('/signup', async (req, reply) => {
    const { username, password, orgSlug } = req.body as {
      username: string;
      password: string;
      orgSlug?: string;
    };

    if (!username || username.length < 3 || username.length > 30) {
      return reply.code(400).send({ error: 'Username must be 3-30 characters' });
    }
    if (!password || password.length < 6) {
      return reply.code(400).send({ error: 'Password must be at least 6 characters' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return reply.code(409).send({ error: 'Username taken' });

    const userId = newId();
    db.prepare('INSERT INTO users(id,username,password_hash) VALUES(?,?,?)').run(
      userId, username, `${salt}:${hash}`
    );

    // org 자동 배정: slug 지정 시 해당 org, 없으면 첫 번째 org
    let orgId: string | null = null;
    if (orgSlug) {
      const org = db.prepare('SELECT id FROM organizations WHERE slug = ?').get(orgSlug) as { id: string } | undefined;
      orgId = org?.id ?? null;
    } else {
      const org = db.prepare('SELECT id FROM organizations ORDER BY created_at LIMIT 1').get() as { id: string } | undefined;
      orgId = org?.id ?? null;
    }

    if (orgId) {
      db.prepare('INSERT OR IGNORE INTO org_members(id,org_id,user_id,role) VALUES(?,?,?,?)').run(
        newId(), orgId, userId, 'member'
      );
    }

    return reply.code(201).send({ ok: true });
  });

  // POST /api/auth/signin
  app.post('/signin', async (req, reply) => {
    const { username, password } = req.body as { username: string; password: string };

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as {
      id: string; password_hash: string;
    } | undefined;

    if (!user) return reply.code(401).send({ error: 'Invalid credentials' });

    const [salt, stored] = user.password_hash.split(':');
    if (hashPassword(password, salt) !== stored) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const sessionId = newId();
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30일
    db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(sessionId, user.id, expiresAt);

    reply.setCookie('session', sessionId, {
      httpOnly: true,
      path: '/',
      expires: new Date(expiresAt * 1000),
      sameSite: 'lax',
    });

    const orgMembership = db.prepare(`
      SELECT om.org_id, om.role, o.name, o.slug
      FROM org_members om JOIN organizations o ON o.id = om.org_id
      WHERE om.user_id = ?
    `).all(user.id) as { org_id: string; role: string; name: string; slug: string }[];

    return { ok: true, orgs: orgMembership };
  });

  // POST /api/auth/signout
  app.post('/signout', async (req, reply) => {
    const sessionId = req.cookies?.session;
    if (sessionId) db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    reply.clearCookie('session');
    return { ok: true };
  });

  // GET /api/auth/me
  app.get('/me', async (req, reply) => {
    const sessionId = req.cookies?.session;
    if (!sessionId) return reply.code(401).send({ error: 'Unauthorized' });

    const now = Math.floor(Date.now() / 1000);
    const row = db.prepare(`
      SELECT u.id, u.username, u.created_at
      FROM sessions s JOIN users u ON s.user_id = u.id
      WHERE s.id = ? AND s.expires_at > ?
    `).get(sessionId, now) as { id: string; username: string; created_at: number } | undefined;

    if (!row) return reply.code(401).send({ error: 'Session expired' });

    const orgs = db.prepare(`
      SELECT om.org_id, om.role, o.name, o.slug
      FROM org_members om JOIN organizations o ON o.id = om.org_id
      WHERE om.user_id = ?
    `).all(row.id) as { org_id: string; role: string; name: string; slug: string }[];

    return { id: row.id, username: row.username, orgs };
  });
}
