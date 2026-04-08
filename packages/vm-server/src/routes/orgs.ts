import type { FastifyInstance } from 'fastify';
import { q1, qall, exec, newId } from '../db/pool.js';
import { requireAuth, requireRole } from '../db/auth.js';

export async function orgRoutes(app: FastifyInstance) {
  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { name, slug } = req.body as { name: string; slug: string };

    if (!name || !slug) return reply.code(400).send({ error: 'name and slug required' });
    if (!/^[a-z0-9-]+$/.test(slug))
      return reply.code(400).send({ error: 'slug must be lowercase alphanumeric with hyphens' });

    const existing = await q1('SELECT id FROM organizations WHERE slug = ?', [slug]);
    if (existing) return reply.code(409).send({ error: 'Slug already taken' });

    const orgId = newId();
    await exec('INSERT INTO organizations(id,name,slug) VALUES(?,?,?)', [orgId, name, slug]);
    await exec(
      'INSERT INTO org_members(id,org_id,user_id,role) VALUES(?,?,?,?) ON CONFLICT(org_id,user_id) DO UPDATE SET role = EXCLUDED.role',
      [newId(), orgId, user.userId, 'org_admin'],
    );

    return reply.code(201).send({ id: orgId, name, slug });
  });

  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    return qall(`
      SELECT o.id, o.name, o.slug, om.role, o.created_at
      FROM organizations o JOIN org_members om ON o.id = om.org_id
      WHERE om.user_id = ?
      ORDER BY o.created_at
    `, [user.userId]);
  });

  app.get('/:orgId/members', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { orgId } = req.params as { orgId: string };
    if (user.orgId !== orgId) return reply.code(403).send({ error: 'Forbidden' });

    return qall(`
      SELECT u.id, u.username, om.role, om.joined_at
      FROM org_members om JOIN users u ON u.id = om.user_id
      WHERE om.org_id = ?
      ORDER BY om.joined_at
    `, [orgId]);
  });

  app.patch('/:orgId/members/:userId', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { orgId, userId } = req.params as { orgId: string; userId: string };
    const { role } = req.body as { role: string };

    if (!requireRole(user, ['org_admin'], reply)) return;
    if (!['org_admin', 'team_admin', 'member'].includes(role))
      return reply.code(400).send({ error: 'Invalid role' });

    await exec('UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?', [role, orgId, userId]);
    return { ok: true };
  });

  app.delete('/:orgId/members/:userId', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { orgId, userId } = req.params as { orgId: string; userId: string };
    if (!requireRole(user, ['org_admin'], reply)) return;
    await exec('DELETE FROM org_members WHERE org_id = ? AND user_id = ?', [orgId, userId]);
    return { ok: true };
  });
}
