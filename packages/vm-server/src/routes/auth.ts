import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { q1, qall, exec, newId, now } from '../db/pool.js';

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/signup', async (req, reply) => {
    const { username, password, workspace } = req.body as {
      username: string; password: string; workspace: string;
    };

    if (!workspace || workspace.length < 2)
      return reply.code(400).send({ error: '워크스페이스를 입력해주세요 (2자 이상)' });
    if (!/^[a-z0-9-]+$/.test(workspace))
      return reply.code(400).send({ error: '워크스페이스는 영문 소문자, 숫자, 하이픈만 사용 가능합니다' });
    if (!username || username.length < 3 || username.length > 30)
      return reply.code(400).send({ error: '아이디는 3~30자여야 합니다' });
    if (!password || password.length < 6)
      return reply.code(400).send({ error: '비밀번호는 6자 이상이어야 합니다' });

    const existing = await q1('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) return reply.code(409).send({ error: '이미 사용 중인 아이디입니다' });

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    const userId = newId();
    await exec('INSERT INTO users(id,username,password_hash) VALUES(?,?,?)', [userId, username, `${salt}:${hash}`]);

    // 워크스페이스(조직) 조회 또는 생성
    let org = await q1<{ id: string }>('SELECT id FROM organizations WHERE slug = ?', [workspace]);
    let role = 'member';

    if (!org) {
      // 워크스페이스가 없으면 새로 생성 (첫 번째 유저 = org_admin)
      const orgId = newId();
      await exec(
        'INSERT INTO organizations(id,name,slug) VALUES(?,?,?)',
        [orgId, workspace, workspace],
      );
      org = { id: orgId };
      role = 'org_admin';
    }

    await exec(
      'INSERT INTO org_members(id,org_id,user_id,role) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
      [newId(), org.id, userId, role],
    );

    return reply.code(201).send({ ok: true });
  });

  app.post('/signin', async (req, reply) => {
    const { username, password, workspace } = req.body as {
      username: string; password: string; workspace: string;
    };

    if (!workspace)
      return reply.code(400).send({ error: '워크스페이스를 입력해주세요' });

    // 워크스페이스(조직) 확인
    const org = await q1<{ id: string }>('SELECT id FROM organizations WHERE slug = ?', [workspace]);
    if (!org)
      return reply.code(404).send({ error: '존재하지 않는 워크스페이스입니다' });

    const user = await q1<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE username = ?', [username],
    );
    if (!user) return reply.code(401).send({ error: '아이디 또는 비밀번호가 올바르지 않습니다' });

    const [salt, stored] = user.password_hash.split(':');
    if (hashPassword(password, salt) !== stored)
      return reply.code(401).send({ error: '아이디 또는 비밀번호가 올바르지 않습니다' });

    // 해당 워크스페이스 멤버인지 확인
    const membership = await q1(
      'SELECT id FROM org_members WHERE org_id = ? AND user_id = ?',
      [org.id, user.id],
    );
    if (!membership)
      return reply.code(403).send({ error: '해당 워크스페이스에 접근 권한이 없습니다' });

    // 세션 생성 (org_id 포함)
    const sessionId = newId();
    const expiresAt = now() + 60 * 60 * 24 * 30;
    await exec(
      'INSERT INTO sessions(id,user_id,org_id,expires_at) VALUES(?,?,?,?)',
      [sessionId, user.id, org.id, expiresAt],
    );

    reply.setCookie('session', sessionId, {
      httpOnly: true, path: '/', expires: new Date(expiresAt * 1000), sameSite: 'lax',
    });

    return { ok: true, workspace, orgId: org.id };
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

    const row = await q1<{ id: string; username: string; org_id: string; created_at: number }>(`
      SELECT u.id, u.username, s.org_id, u.created_at
      FROM sessions s JOIN users u ON s.user_id = u.id
      WHERE s.id = ? AND s.expires_at > ?
    `, [sessionId, now()]);

    if (!row) return reply.code(401).send({ error: 'Session expired' });

    const orgs = await qall<{ org_id: string; role: string; name: string; slug: string }>(`
      SELECT om.org_id, om.role, o.name, o.slug
      FROM org_members om JOIN organizations o ON o.id = om.org_id
      WHERE om.user_id = ?
    `, [row.id]);

    // 현재 세션의 워크스페이스 정보
    const currentOrg = orgs.find(o => o.org_id === row.org_id);

    return {
      id: row.id,
      username: row.username,
      orgs,
      currentWorkspace: currentOrg ? { orgId: currentOrg.org_id, slug: currentOrg.slug, name: currentOrg.name, role: currentOrg.role } : null,
    };
  });
}
