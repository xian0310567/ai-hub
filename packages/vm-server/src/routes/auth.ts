import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { q1, qall, exec, newId, now } from '../db/pool.js';

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/signup', async (req, reply) => {
    const { username, password, orgSlug } = req.body as {
      username: string; password: string; orgSlug?: string;
    };

    if (!username || username.length < 3 || username.length > 30)
      return reply.code(400).send({ error: 'Username must be 3-30 characters' });
    if (!password || password.length < 6)
      return reply.code(400).send({ error: 'Password must be at least 6 characters' });

    const existing = await q1('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) return reply.code(409).send({ error: 'Username taken' });

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    const userId = newId();
    await exec('INSERT INTO users(id,username,password_hash) VALUES(?,?,?)', [userId, username, `${salt}:${hash}`]);

    let orgId: string | null = null;
    let role = 'member';

    if (orgSlug) {
      const org = await q1<{ id: string }>('SELECT id FROM organizations WHERE slug = ?', [orgSlug]);
      orgId = org?.id ?? null;
    } else {
      const org = await q1<{ id: string }>('SELECT id FROM organizations ORDER BY created_at LIMIT 1');
      orgId = org?.id ?? null;
    }

    // 조직이 없으면 기본 조직 자동 생성 (첫 번째 유저 = org_admin)
    if (!orgId) {
      orgId = newId();
      await exec(
        'INSERT INTO organizations(id,name,slug) VALUES(?,?,?)',
        [orgId, 'AI 사업부', 'default'],
      );
      role = 'org_admin';
    }

    await exec(
      'INSERT INTO org_members(id,org_id,user_id,role) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
      [newId(), orgId, userId, role],
    );

    return reply.code(201).send({ ok: true });
  });

  app.post('/signin', async (req, reply) => {
    const { username, password } = req.body as { username: string; password: string };

    const user = await q1<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE username = ?', [username],
    );
    if (!user) return reply.code(401).send({ error: 'Invalid credentials' });

    const [salt, stored] = user.password_hash.split(':');
    if (hashPassword(password, salt) !== stored)
      return reply.code(401).send({ error: 'Invalid credentials' });

    // org 멤버십이 없는 기존 유저 → 자동 연결
    const membership = await q1('SELECT id FROM org_members WHERE user_id = ?', [user.id]);
    if (!membership) {
      let org = await q1<{ id: string }>('SELECT id FROM organizations ORDER BY created_at LIMIT 1');
      if (!org) {
        const orgId = newId();
        await exec('INSERT INTO organizations(id,name,slug) VALUES(?,?,?)', [orgId, 'AI 사업부', 'default']);
        org = { id: orgId };
      }
      await exec(
        'INSERT INTO org_members(id,org_id,user_id,role) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
        [newId(), org.id, user.id, 'org_admin'],
      );
    }

    const sessionId = newId();
    const expiresAt = now() + 60 * 60 * 24 * 30;
    await exec('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)', [sessionId, user.id, expiresAt]);

    reply.setCookie('session', sessionId, {
      httpOnly: true, path: '/', expires: new Date(expiresAt * 1000), sameSite: 'lax',
    });

    const orgs = await qall<{ org_id: string; role: string; name: string; slug: string }>(`
      SELECT om.org_id, om.role, o.name, o.slug
      FROM org_members om JOIN organizations o ON o.id = om.org_id
      WHERE om.user_id = ?
    `, [user.id]);

    return { ok: true, orgs };
  });

  app.post('/signout', async (req, reply) => {
    const sessionId = req.cookies?.session;
    if (sessionId) await exec('DELETE FROM sessions WHERE id = ?', [sessionId]);
    reply.clearCookie('session');
    return { ok: true };
  });

  app.get('/me', async (req, reply) => {
    const sessionId = req.cookies?.session;
    if (!sessionId) return reply.code(401).send({ error: 'Unauthorized' });

    const row = await q1<{ id: string; username: string; created_at: number }>(`
      SELECT u.id, u.username, u.created_at
      FROM sessions s JOIN users u ON s.user_id = u.id
      WHERE s.id = ? AND s.expires_at > ?
    `, [sessionId, now()]);

    if (!row) return reply.code(401).send({ error: 'Session expired' });

    const orgs = await qall<{ org_id: string; role: string; name: string; slug: string }>(`
      SELECT om.org_id, om.role, o.name, o.slug
      FROM org_members om JOIN organizations o ON o.id = om.org_id
      WHERE om.user_id = ?
    `, [row.id]);

    return { id: row.id, username: row.username, orgs };
  });
}
