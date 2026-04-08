import type { FastifyInstance } from 'fastify';
import { db, newId } from '../db/schema.js';
import { requireAuth, requireRole } from '../db/auth.js';

export async function orgRoutes(app: FastifyInstance) {
  // POST /api/orgs — 조직 생성 (첫 사용자가 org_admin이 됨)
  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { name, slug } = req.body as { name: string; slug: string };

    if (!name || !slug) return reply.code(400).send({ error: 'name and slug required' });
    if (!/^[a-z0-9-]+$/.test(slug)) return reply.code(400).send({ error: 'slug must be lowercase alphanumeric with hyphens' });

    const existing = db.prepare('SELECT id FROM organizations WHERE slug = ?').get(slug);
    if (existing) return reply.code(409).send({ error: 'Slug already taken' });

    const orgId = newId();
    db.prepare('INSERT INTO organizations(id,name,slug) VALUES(?,?,?)').run(orgId, name, slug);
    db.prepare('INSERT OR REPLACE INTO org_members(id,org_id,user_id,role) VALUES(?,?,?,?)').run(
      newId(), orgId, user.userId, 'org_admin'
    );

    return reply.code(201).send({ id: orgId, name, slug });
  });

  // GET /api/orgs — 내가 속한 조직 목록
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const orgs = db.prepare(`
      SELECT o.id, o.name, o.slug, om.role, o.created_at
      FROM organizations o JOIN org_members om ON o.id = om.org_id
      WHERE om.user_id = ?
      ORDER BY o.created_at
    `).all(user.userId);
    return orgs;
  });

  // GET /api/orgs/:orgId/members
  app.get('/:orgId/members', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { orgId } = req.params as { orgId: string };

    if (user.orgId !== orgId) return reply.code(403).send({ error: 'Forbidden' });

    const members = db.prepare(`
      SELECT u.id, u.username, om.role, om.joined_at
      FROM org_members om JOIN users u ON u.id = om.user_id
      WHERE om.org_id = ?
      ORDER BY om.joined_at
    `).all(orgId);
    return members;
  });

  // PATCH /api/orgs/:orgId/members/:userId — 역할 변경 (org_admin만)
  app.patch('/:orgId/members/:userId', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { orgId, userId } = req.params as { orgId: string; userId: string };
    const { role } = req.body as { role: string };

    if (!requireRole(user, ['org_admin'], reply)) return;
    if (!['org_admin', 'team_admin', 'member'].includes(role)) {
      return reply.code(400).send({ error: 'Invalid role' });
    }

    db.prepare('UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?').run(role, orgId, userId);
    return { ok: true };
  });

  // DELETE /api/orgs/:orgId/members/:userId — 멤버 제거
  app.delete('/:orgId/members/:userId', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { orgId, userId } = req.params as { orgId: string; userId: string };

    if (!requireRole(user, ['org_admin'], reply)) return;
    db.prepare('DELETE FROM org_members WHERE org_id = ? AND user_id = ?').run(orgId, userId);
    return { ok: true };
  });
}
