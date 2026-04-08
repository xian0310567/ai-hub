import type { FastifyInstance } from 'fastify';
import { db, newId } from '../db/schema.js';
import { requireAuth } from '../db/auth.js';

export async function divisionRoutes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    return db.prepare('SELECT * FROM divisions WHERE org_id = ? ORDER BY order_index, created_at').all(user.orgId);
  });

  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { name, color, ws_path } = req.body as { name: string; color?: string; ws_path?: string };
    if (!name) return reply.code(400).send({ error: 'name required' });

    const id = newId();
    db.prepare('INSERT INTO divisions(id,org_id,name,color,ws_path) VALUES(?,?,?,?,?)').run(
      id, user.orgId, name, color ?? '#6b7280', ws_path ?? ''
    );
    return reply.code(201).send(db.prepare('SELECT * FROM divisions WHERE id = ?').get(id));
  });

  app.patch('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id, name, color, ws_path, harness_prompt } = req.body as {
      id: string; name?: string; color?: string; ws_path?: string; harness_prompt?: string;
    };
    if (!id) return reply.code(400).send({ error: 'id required' });

    const existing = db.prepare('SELECT id FROM divisions WHERE id = ? AND org_id = ?').get(id, user.orgId);
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    if (name !== undefined) db.prepare('UPDATE divisions SET name = ? WHERE id = ?').run(name, id);
    if (color !== undefined) db.prepare('UPDATE divisions SET color = ? WHERE id = ?').run(color, id);
    if (ws_path !== undefined) db.prepare('UPDATE divisions SET ws_path = ? WHERE id = ?').run(ws_path, id);
    if (harness_prompt !== undefined) db.prepare('UPDATE divisions SET harness_prompt = ? WHERE id = ?').run(harness_prompt, id);

    return db.prepare('SELECT * FROM divisions WHERE id = ?').get(id);
  });

  app.delete('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id } = req.body as { id: string };
    db.prepare('DELETE FROM divisions WHERE id = ? AND org_id = ?').run(id, user.orgId);
    return { ok: true };
  });

  app.post('/reorder', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { ids } = req.body as { ids: string[] };
    ids.forEach((id, i) => {
      db.prepare('UPDATE divisions SET order_index = ? WHERE id = ? AND org_id = ?').run(i, id, user.orgId);
    });
    return { ok: true };
  });
}
