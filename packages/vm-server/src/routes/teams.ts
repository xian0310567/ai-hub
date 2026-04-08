import type { FastifyInstance } from 'fastify';
import { db, newId } from '../db/schema.js';
import { requireAuth } from '../db/auth.js';

export async function teamRoutes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { workspace_id } = req.query as { workspace_id?: string };
    if (workspace_id) {
      return db.prepare('SELECT * FROM teams WHERE org_id = ? AND workspace_id = ? ORDER BY order_index, created_at').all(user.orgId, workspace_id);
    }
    return db.prepare('SELECT * FROM teams WHERE org_id = ? ORDER BY order_index, created_at').all(user.orgId);
  });

  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { name, workspace_id, description, color } = req.body as {
      name: string; workspace_id: string; description?: string; color?: string;
    };
    if (!name || !workspace_id) return reply.code(400).send({ error: 'name and workspace_id required' });

    const id = newId();
    db.prepare('INSERT INTO teams(id,org_id,workspace_id,name,description,color) VALUES(?,?,?,?,?,?)').run(
      id, user.orgId, workspace_id, name, description ?? '', color ?? '#6b7280'
    );
    return reply.code(201).send(db.prepare('SELECT * FROM teams WHERE id = ?').get(id));
  });

  app.patch('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id, name, description, color, workspace_id, harness_prompt } = req.body as {
      id: string; name?: string; description?: string; color?: string; workspace_id?: string; harness_prompt?: string;
    };
    if (!id) return reply.code(400).send({ error: 'id required' });

    const existing = db.prepare('SELECT id FROM teams WHERE id = ? AND org_id = ?').get(id, user.orgId);
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    if (name !== undefined) db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, id);
    if (description !== undefined) db.prepare('UPDATE teams SET description = ? WHERE id = ?').run(description, id);
    if (color !== undefined) db.prepare('UPDATE teams SET color = ? WHERE id = ?').run(color, id);
    if (workspace_id !== undefined) db.prepare('UPDATE teams SET workspace_id = ? WHERE id = ?').run(workspace_id, id);
    if (harness_prompt !== undefined) db.prepare('UPDATE teams SET harness_prompt = ? WHERE id = ?').run(harness_prompt, id);

    return db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  });

  app.delete('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id } = req.body as { id: string };
    db.prepare('DELETE FROM teams WHERE id = ? AND org_id = ?').run(id, user.orgId);
    return { ok: true };
  });

  app.post('/reorder', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { ids } = req.body as { ids: string[] };
    ids.forEach((id, i) => {
      db.prepare('UPDATE teams SET order_index = ? WHERE id = ? AND org_id = ?').run(i, id, user.orgId);
    });
    return { ok: true };
  });

  // 팀 멤버 관리
  app.get('/:teamId/members', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { teamId } = req.params as { teamId: string };
    return db.prepare(`
      SELECT u.id, u.username, tm.role, tm.joined_at
      FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ?
    `).all(teamId);
  });

  app.post('/:teamId/members', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { teamId } = req.params as { teamId: string };
    const { user_id, role } = req.body as { user_id: string; role?: string };
    db.prepare('INSERT OR IGNORE INTO team_members(id,team_id,user_id,role) VALUES(?,?,?,?)').run(
      newId(), teamId, user_id, role ?? 'member'
    );
    return { ok: true };
  });

  app.delete('/:teamId/members/:userId', async (req, reply) => {
    await requireAuth(req, reply);
    const { teamId, userId } = req.params as { teamId: string; userId: string };
    db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, userId);
    return { ok: true };
  });
}
