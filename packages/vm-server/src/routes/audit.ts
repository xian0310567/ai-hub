import type { FastifyInstance } from 'fastify';
import { db } from '../db/schema.js';
import { requireAuth, requireRole } from '../db/auth.js';

export async function auditRoutes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin'], reply)) return;
    const { user_id, resource, action, limit } = req.query as {
      user_id?: string; resource?: string; action?: string; limit?: string;
    };

    let query = 'SELECT al.*, u.username FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id WHERE al.org_id = ?';
    const params: unknown[] = [user.orgId];

    if (user_id) { query += ' AND al.user_id = ?'; params.push(user_id); }
    if (resource) { query += ' AND al.resource = ?'; params.push(resource); }
    if (action) { query += ' AND al.action LIKE ?'; params.push(`${action}%`); }

    query += ' ORDER BY al.created_at DESC LIMIT ?';
    params.push(Number(limit) || 100);

    return db.prepare(query).all(...params);
  });
}
