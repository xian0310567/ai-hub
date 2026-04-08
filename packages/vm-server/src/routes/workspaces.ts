import type { FastifyInstance } from 'fastify';
import { db, newId } from '../db/schema.js';
import { requireAuth } from '../db/auth.js';

export async function workspaceRoutes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    return db.prepare('SELECT * FROM workspaces WHERE org_id = ? ORDER BY order_index, created_at').all(user.orgId);
  });

  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { name, path, division_id } = req.body as { name: string; path: string; division_id?: string };
    if (!name || !path) return reply.code(400).send({ error: 'name and path required' });

    const id = newId();
    db.prepare('INSERT INTO workspaces(id,org_id,name,path,division_id) VALUES(?,?,?,?,?)').run(
      id, user.orgId, name, path, division_id ?? null
    );
    return reply.code(201).send(db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id));
  });

  app.get('/:id', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const ws = db.prepare('SELECT * FROM workspaces WHERE id = ? AND org_id = ?').get(id, user.orgId);
    if (!ws) return reply.code(404).send({ error: 'Not found' });
    return ws;
  });

  app.patch('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id, name, path, division_id, harness_prompt } = req.body as {
      id: string; name?: string; path?: string; division_id?: string | null; harness_prompt?: string;
    };
    if (!id) return reply.code(400).send({ error: 'id required' });

    const existing = db.prepare('SELECT id FROM workspaces WHERE id = ? AND org_id = ?').get(id, user.orgId);
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    if (name !== undefined) db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name, id);
    if (path !== undefined) db.prepare('UPDATE workspaces SET path = ? WHERE id = ?').run(path, id);
    if (division_id !== undefined) db.prepare('UPDATE workspaces SET division_id = ? WHERE id = ?').run(division_id, id);
    if (harness_prompt !== undefined) db.prepare('UPDATE workspaces SET harness_prompt = ? WHERE id = ?').run(harness_prompt, id);

    return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
  });

  app.delete('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id } = req.body as { id: string };
    db.prepare('DELETE FROM workspaces WHERE id = ? AND org_id = ?').run(id, user.orgId);
    return { ok: true };
  });

  app.post('/reorder', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { ids } = req.body as { ids: string[] };
    ids.forEach((id, i) => {
      db.prepare('UPDATE workspaces SET order_index = ? WHERE id = ? AND org_id = ?').run(i, id, user.orgId);
    });
    return { ok: true };
  });
}
