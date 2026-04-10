import type { FastifyInstance } from 'fastify';
import { q1, qall, exec, newId } from '../db/pool.js';
import { requireAuth, requireRole } from '../db/auth.js';

export async function teamRoutes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { workspace_id } = req.query as { workspace_id?: string };
    if (workspace_id) {
      return qall('SELECT * FROM teams WHERE org_id = ? AND workspace_id = ? ORDER BY order_index, created_at',
        [user.orgId, workspace_id]);
    }
    return qall('SELECT * FROM teams WHERE org_id = ? ORDER BY order_index, created_at', [user.orgId]);
  });

  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;
    const { name, workspace_id, description, color } = req.body as {
      name: string; workspace_id: string; description?: string; color?: string;
    };
    if (!name || !workspace_id) return reply.code(400).send({ error: 'name and workspace_id required' });

    const id = newId();
    await exec('INSERT INTO teams(id,org_id,workspace_id,name,description,color) VALUES(?,?,?,?,?,?)',
      [id, user.orgId, workspace_id, name, description ?? '', color ?? '#6b7280']);
    return reply.code(201).send(await q1('SELECT * FROM teams WHERE id = ?', [id]));
  });

  app.get('/:id', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const team = await q1('SELECT * FROM teams WHERE id = ? AND org_id = ?', [id, user.orgId]);
    if (!team) return reply.code(404).send({ error: 'Not found' });
    return team;
  });

  app.patch('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;
    const { id, name, description, color, workspace_id, harness_prompt } = req.body as {
      id: string; name?: string; description?: string; color?: string;
      workspace_id?: string; harness_prompt?: string;
    };
    if (!id) return reply.code(400).send({ error: 'id required' });
    const existing = await q1('SELECT id FROM teams WHERE id = ? AND org_id = ?', [id, user.orgId]);
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    if (name !== undefined) await exec('UPDATE teams SET name = ? WHERE id = ?', [name, id]);
    if (description !== undefined) await exec('UPDATE teams SET description = ? WHERE id = ?', [description, id]);
    if (color !== undefined) await exec('UPDATE teams SET color = ? WHERE id = ?', [color, id]);
    if (workspace_id !== undefined) await exec('UPDATE teams SET workspace_id = ? WHERE id = ?', [workspace_id, id]);
    if (harness_prompt !== undefined) await exec('UPDATE teams SET harness_prompt = ? WHERE id = ?', [harness_prompt, id]);

    return q1('SELECT * FROM teams WHERE id = ?', [id]);
  });

  app.delete('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;
    const { id } = req.body as { id: string };
    const child = await q1('SELECT id FROM parts WHERE team_id = ? LIMIT 1', [id]);
    if (child) {
      reply.code(409);
      return { ok: false, error: '하위 파트가 존재합니다. 먼저 하위 조직을 삭제해주세요.' };
    }
    await exec('DELETE FROM teams WHERE id = ? AND org_id = ?', [id, user.orgId]);
    return { ok: true };
  });

  app.post('/reorder', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;
    const { ids } = req.body as { ids: string[] };
    await Promise.all(ids.map((id, i) =>
      exec('UPDATE teams SET order_index = ? WHERE id = ? AND org_id = ?', [i, id, user.orgId])
    ));
    return { ok: true };
  });

  // 팀 멤버 관리
  app.get('/:teamId/members', async (req, reply) => {
    await requireAuth(req, reply);
    const { teamId } = req.params as { teamId: string };
    return qall(`
      SELECT u.id, u.username, tm.role, tm.joined_at
      FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ?
    `, [teamId]);
  });

  app.post('/:teamId/members', async (req, reply) => {
    await requireAuth(req, reply);
    const { teamId } = req.params as { teamId: string };
    const { user_id, role } = req.body as { user_id: string; role?: string };
    await exec(
      'INSERT INTO team_members(id,team_id,user_id,role) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
      [newId(), teamId, user_id, role ?? 'member'],
    );
    return { ok: true };
  });

  app.delete('/:teamId/members/:userId', async (req, reply) => {
    await requireAuth(req, reply);
    const { teamId, userId } = req.params as { teamId: string; userId: string };
    await exec('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', [teamId, userId]);
    return { ok: true };
  });
}
