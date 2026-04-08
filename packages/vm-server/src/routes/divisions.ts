import type { FastifyInstance } from 'fastify';
import { q1, qall, exec, newId } from '../db/pool.js';
import { requireAuth, requireRole } from '../db/auth.js';

export async function divisionRoutes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    return qall('SELECT * FROM divisions WHERE org_id = ? ORDER BY order_index, created_at', [user.orgId]);
  });

  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin'], reply)) return;
    const { name, color, ws_path } = req.body as { name: string; color?: string; ws_path?: string };
    if (!name) return reply.code(400).send({ error: 'name required' });

    const id = newId();
    await exec('INSERT INTO divisions(id,org_id,name,color,ws_path) VALUES(?,?,?,?,?)',
      [id, user.orgId, name, color ?? '#6b7280', ws_path ?? '']);
    return reply.code(201).send(await q1('SELECT * FROM divisions WHERE id = ?', [id]));
  });

  app.get('/:id', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const div = await q1('SELECT * FROM divisions WHERE id = ? AND org_id = ?', [id, user.orgId]);
    if (!div) return reply.code(404).send({ error: 'Not found' });
    return div;
  });

  app.patch('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin'], reply)) return;
    const { id, name, color, ws_path, harness_prompt } = req.body as {
      id: string; name?: string; color?: string; ws_path?: string; harness_prompt?: string;
    };
    if (!id) return reply.code(400).send({ error: 'id required' });
    const existing = await q1('SELECT id FROM divisions WHERE id = ? AND org_id = ?', [id, user.orgId]);
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    if (name !== undefined) await exec('UPDATE divisions SET name = ? WHERE id = ?', [name, id]);
    if (color !== undefined) await exec('UPDATE divisions SET color = ? WHERE id = ?', [color, id]);
    if (ws_path !== undefined) await exec('UPDATE divisions SET ws_path = ? WHERE id = ?', [ws_path, id]);
    if (harness_prompt !== undefined) await exec('UPDATE divisions SET harness_prompt = ? WHERE id = ?', [harness_prompt, id]);

    return q1('SELECT * FROM divisions WHERE id = ?', [id]);
  });

  app.delete('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin'], reply)) return;
    const { id } = req.body as { id: string };
    await exec('DELETE FROM divisions WHERE id = ? AND org_id = ?', [id, user.orgId]);
    return { ok: true };
  });

  app.post('/reorder', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin'], reply)) return;
    const { ids } = req.body as { ids: string[] };
    await Promise.all(ids.map((id, i) =>
      exec('UPDATE divisions SET order_index = ? WHERE id = ? AND org_id = ?', [i, id, user.orgId])
    ));
    return { ok: true };
  });
}
