import type { FastifyInstance } from 'fastify';
import { qall, buildWhere } from '../db/pool.js';
import { requireAuth, requireRole } from '../db/auth.js';

export async function auditRoutes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin'], reply)) return;

    const { user_id, resource, action, limit } = req.query as {
      user_id?: string; resource?: string; action?: string; limit?: string;
    };

    const [sql, params] = buildWhere(
      'SELECT al.*, u.username FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id WHERE al.org_id = $1',
      [user.orgId],
      [
        user_id ? ['al.user_id = ?', user_id] : null,
        resource ? ['al.resource = ?', resource] : null,
        action ? ['al.action LIKE ?', `${action}%`] : null,
      ],
    );

    const limitN = Number(limit) || 100;
    return qall(`${sql} ORDER BY al.created_at DESC LIMIT $${params.length + 1}`,
      [...params, limitN]);
  });
}
