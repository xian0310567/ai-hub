import type { FastifyInstance } from 'fastify';
import { q1, qall, exec, newId } from '../db/pool.js';
import { requireAuth, requireRole } from '../db/auth.js';

export async function workspaceRoutes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    return qall('SELECT * FROM workspaces WHERE org_id = ? ORDER BY order_index, created_at', [user.orgId]);
  });

  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin'], reply)) return;
    const { name, path: wsPath, division_id } = req.body as { name: string; path?: string; division_id?: string };
    if (!name) return reply.code(400).send({ error: 'name required' });
    const finalPath = wsPath || name.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-');

    const id = newId();
    await exec('INSERT INTO workspaces(id,org_id,name,path,division_id) VALUES(?,?,?,?,?)',
      [id, user.orgId, name, finalPath, division_id ?? null]);
    return reply.code(201).send(await q1('SELECT * FROM workspaces WHERE id = ?', [id]));
  });

  app.get('/:id', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const ws = await q1('SELECT * FROM workspaces WHERE id = ? AND org_id = ?', [id, user.orgId]);
    if (!ws) return reply.code(404).send({ error: 'Not found' });
    return ws;
  });

  app.patch('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin'], reply)) return;
    const { id, name, path, division_id, harness_prompt } = req.body as {
      id: string; name?: string; path?: string; division_id?: string | null; harness_prompt?: string;
    };
    if (!id) return reply.code(400).send({ error: 'id required' });
    const existing = await q1('SELECT id FROM workspaces WHERE id = ? AND org_id = ?', [id, user.orgId]);
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    if (name !== undefined) await exec('UPDATE workspaces SET name = ? WHERE id = ?', [name, id]);
    if (path !== undefined) await exec('UPDATE workspaces SET path = ? WHERE id = ?', [path, id]);
    if (division_id !== undefined) await exec('UPDATE workspaces SET division_id = ? WHERE id = ?', [division_id, id]);
    if (harness_prompt !== undefined) await exec('UPDATE workspaces SET harness_prompt = ? WHERE id = ?', [harness_prompt, id]);

    return q1('SELECT * FROM workspaces WHERE id = ?', [id]);
  });

  app.delete('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin'], reply)) return;
    const { id } = req.body as { id: string };
    await exec('DELETE FROM workspaces WHERE id = ? AND org_id = ?', [id, user.orgId]);
    return { ok: true };
  });

  app.post('/reorder', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin'], reply)) return;
    const { ids } = req.body as { ids: string[] };
    await Promise.all(ids.map((id, i) =>
      exec('UPDATE workspaces SET order_index = ? WHERE id = ? AND org_id = ?', [i, id, user.orgId])
    ));
    return { ok: true };
  });
}
