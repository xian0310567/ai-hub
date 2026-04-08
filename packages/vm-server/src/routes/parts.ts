import type { FastifyInstance } from 'fastify';
import { q1, qall, exec, newId } from '../db/pool.js';
import { requireAuth, requireRole } from '../db/auth.js';

export async function partRoutes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { team_id } = req.query as { team_id?: string };
    if (team_id) {
      return qall('SELECT * FROM parts WHERE org_id = ? AND team_id = ? ORDER BY order_index, created_at',
        [user.orgId, team_id]);
    }
    return qall('SELECT * FROM parts WHERE org_id = ? ORDER BY order_index, created_at', [user.orgId]);
  });

  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;
    const { team_id, name, color } = req.body as { team_id: string; name: string; color?: string };
    if (!team_id || !name) return reply.code(400).send({ error: 'team_id and name required' });

    const id = newId();
    await exec('INSERT INTO parts(id,org_id,team_id,name,color) VALUES(?,?,?,?,?)',
      [id, user.orgId, team_id, name, color ?? '#6b7280']);
    return reply.code(201).send(await q1('SELECT * FROM parts WHERE id = ?', [id]));
  });

  app.patch('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;
    const { id, name, color, team_id } = req.body as {
      id: string; name?: string; color?: string; team_id?: string;
    };
    if (!id) return reply.code(400).send({ error: 'id required' });
    const existing = await q1('SELECT id FROM parts WHERE id = ? AND org_id = ?', [id, user.orgId]);
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    if (name !== undefined) await exec('UPDATE parts SET name = ? WHERE id = ?', [name, id]);
    if (color !== undefined) await exec('UPDATE parts SET color = ? WHERE id = ?', [color, id]);
    if (team_id !== undefined) await exec('UPDATE parts SET team_id = ? WHERE id = ?', [team_id, id]);

    return q1('SELECT * FROM parts WHERE id = ?', [id]);
  });

  app.delete('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;
    const { id } = req.body as { id: string };
    await exec('DELETE FROM parts WHERE id = ? AND org_id = ?', [id, user.orgId]);
    return { ok: true };
  });

  app.post('/reorder', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;
    const { ids } = req.body as { ids: string[] };
    await Promise.all(ids.map((id, i) =>
      exec('UPDATE parts SET order_index = ? WHERE id = ? AND org_id = ?', [i, id, user.orgId])
    ));
    return { ok: true };
  });
}
