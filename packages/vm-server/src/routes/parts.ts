import type { FastifyInstance } from 'fastify';
import { db, newId } from '../db/schema.js';
import { requireAuth } from '../db/auth.js';

export async function partRoutes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { team_id } = req.query as { team_id?: string };
    if (team_id) {
      return db.prepare('SELECT * FROM parts WHERE org_id = ? AND team_id = ? ORDER BY order_index, created_at').all(user.orgId, team_id);
    }
    return db.prepare('SELECT * FROM parts WHERE org_id = ? ORDER BY order_index, created_at').all(user.orgId);
  });

  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { team_id, name, color } = req.body as { team_id: string; name: string; color?: string };
    if (!team_id || !name) return reply.code(400).send({ error: 'team_id and name required' });

    const id = newId();
    db.prepare('INSERT INTO parts(id,org_id,team_id,name,color) VALUES(?,?,?,?,?)').run(
      id, user.orgId, team_id, name, color ?? '#6b7280'
    );
    return reply.code(201).send(db.prepare('SELECT * FROM parts WHERE id = ?').get(id));
  });

  app.patch('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id, name, color, team_id } = req.body as { id: string; name?: string; color?: string; team_id?: string };
    if (!id) return reply.code(400).send({ error: 'id required' });

    const existing = db.prepare('SELECT id FROM parts WHERE id = ? AND org_id = ?').get(id, user.orgId);
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    if (name !== undefined) db.prepare('UPDATE parts SET name = ? WHERE id = ?').run(name, id);
    if (color !== undefined) db.prepare('UPDATE parts SET color = ? WHERE id = ?').run(color, id);
    if (team_id !== undefined) db.prepare('UPDATE parts SET team_id = ? WHERE id = ?').run(team_id, id);

    return db.prepare('SELECT * FROM parts WHERE id = ?').get(id);
  });

  app.delete('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id } = req.body as { id: string };
    db.prepare('DELETE FROM parts WHERE id = ? AND org_id = ?').run(id, user.orgId);
    return { ok: true };
  });

  app.post('/reorder', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { ids } = req.body as { ids: string[] };
    ids.forEach((id, i) => {
      db.prepare('UPDATE parts SET order_index = ? WHERE id = ? AND org_id = ?').run(i, id, user.orgId);
    });
    return { ok: true };
  });
}
