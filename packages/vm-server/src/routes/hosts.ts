import type { FastifyInstance } from 'fastify';
import { db, newId } from '../db/schema.js';
import { requireAuth } from '../db/auth.js';

export async function hostRoutes(app: FastifyInstance) {
  // 호스트 등록
  app.post('/register', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { name } = req.body as { name: string };
    if (!name) return reply.code(400).send({ error: 'name required' });

    const existing = db.prepare('SELECT id FROM hosts WHERE org_id = ? AND user_id = ? AND name = ?').get(user.orgId, user.userId, name);
    if (existing) {
      // 이미 있으면 online으로 업데이트
      db.prepare('UPDATE hosts SET status = ?, last_heartbeat = ? WHERE id = ?').run(
        'idle', Math.floor(Date.now() / 1000), (existing as { id: string }).id
      );
      return { id: (existing as { id: string }).id };
    }

    const id = newId();
    db.prepare('INSERT INTO hosts(id,org_id,user_id,name,status,last_heartbeat) VALUES(?,?,?,?,?,?)').run(
      id, user.orgId, user.userId, name, 'idle', Math.floor(Date.now() / 1000)
    );
    return reply.code(201).send({ id });
  });

  // Heartbeat
  app.post('/:hostId/heartbeat', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { hostId } = req.params as { hostId: string };
    const { status } = req.body as { status?: string };

    const host = db.prepare('SELECT id FROM hosts WHERE id = ? AND user_id = ?').get(hostId, user.userId);
    if (!host) return reply.code(404).send({ error: 'Host not found' });

    db.prepare('UPDATE hosts SET status = ?, last_heartbeat = ? WHERE id = ?').run(
      status ?? 'idle', Math.floor(Date.now() / 1000), hostId
    );
    return { ok: true };
  });

  // 조직 내 호스트 목록
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const now = Math.floor(Date.now() / 1000);
    const offlineThreshold = now - 5 * 60; // 5분

    // 오래된 heartbeat → offline 처리
    db.prepare('UPDATE hosts SET status = ? WHERE org_id = ? AND last_heartbeat < ? AND status != ?').run(
      'offline', user.orgId, offlineThreshold, 'offline'
    );

    return db.prepare(`
      SELECT h.id, h.name, h.status, h.last_heartbeat, u.username
      FROM hosts h JOIN users u ON u.id = h.user_id
      WHERE h.org_id = ?
      ORDER BY h.last_heartbeat DESC
    `).all(user.orgId);
  });
}
