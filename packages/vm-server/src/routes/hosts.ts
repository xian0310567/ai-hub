import type { FastifyInstance } from 'fastify';
import { q1, qall, exec, newId, now } from '../db/pool.js';
import { requireAuth } from '../db/auth.js';

export async function hostRoutes(app: FastifyInstance) {
  app.post('/register', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { name } = req.body as { name: string };
    if (!name) return reply.code(400).send({ error: 'name required' });

    const existing = await q1<{ id: string }>(
      'SELECT id FROM hosts WHERE org_id = ? AND user_id = ? AND name = ?',
      [user.orgId, user.userId, name],
    );

    if (existing) {
      await exec('UPDATE hosts SET status = ?, last_heartbeat = ? WHERE id = ?',
        ['idle', now(), existing.id]);
      return { id: existing.id };
    }

    const id = newId();
    await exec('INSERT INTO hosts(id,org_id,user_id,name,status,last_heartbeat) VALUES(?,?,?,?,?,?)',
      [id, user.orgId, user.userId, name, 'idle', now()]);
    return reply.code(201).send({ id });
  });

  app.post('/:hostId/heartbeat', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { hostId } = req.params as { hostId: string };
    const { status } = req.body as { status?: string };

    const host = await q1('SELECT id FROM hosts WHERE id = ? AND user_id = ?', [hostId, user.userId]);
    if (!host) return reply.code(404).send({ error: 'Host not found' });

    await exec('UPDATE hosts SET status = ?, last_heartbeat = ? WHERE id = ?',
      [status ?? 'idle', now(), hostId]);
    return { ok: true };
  });

  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const offlineThreshold = now() - 5 * 60;

    // 오래된 heartbeat → offline
    await exec(
      "UPDATE hosts SET status = 'offline' WHERE org_id = ? AND last_heartbeat < ? AND status != 'offline'",
      [user.orgId, offlineThreshold],
    );

    return qall(`
      SELECT h.id, h.name, h.status, h.last_heartbeat, u.username
      FROM hosts h JOIN users u ON u.id = h.user_id
      WHERE h.org_id = ?
      ORDER BY h.last_heartbeat DESC
    `, [user.orgId]);
  });
}
