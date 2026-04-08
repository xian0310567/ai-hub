import type { FastifyInstance } from 'fastify';
import { q1, qall, exec, newId } from '../db/pool.js';
import { requireAuth, requireRole } from '../db/auth.js';

export async function agentRoutes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { workspace_id, team_id } = req.query as { workspace_id?: string; team_id?: string };
    if (workspace_id)
      return qall('SELECT * FROM agents WHERE org_id = ? AND workspace_id = ? ORDER BY created_at', [user.orgId, workspace_id]);
    if (team_id)
      return qall('SELECT * FROM agents WHERE org_id = ? AND team_id = ? ORDER BY created_at', [user.orgId, team_id]);
    return qall('SELECT * FROM agents WHERE org_id = ? ORDER BY created_at', [user.orgId]);
  });

  app.get('/:id', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const agent = await q1('SELECT * FROM agents WHERE id = ? AND org_id = ?', [id, user.orgId]);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    return agent;
  });

  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;
    const {
      workspace_id, team_id, part_id, parent_agent_id, org_level, is_lead,
      name, emoji, color, soul, command_name, harness_pattern, model,
    } = req.body as {
      workspace_id?: string; team_id?: string; part_id?: string; parent_agent_id?: string;
      org_level?: string; is_lead?: boolean; name: string; emoji?: string; color?: string;
      soul?: string; command_name?: string; harness_pattern?: string; model?: string;
    };
    if (!name) return reply.code(400).send({ error: 'name required' });

    const id = newId();
    await exec(`
      INSERT INTO agents(id,org_id,workspace_id,team_id,part_id,parent_agent_id,
        org_level,is_lead,name,emoji,color,soul,command_name,harness_pattern,model)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      id, user.orgId, workspace_id ?? null, team_id ?? null, part_id ?? null, parent_agent_id ?? null,
      org_level ?? 'worker', is_lead ?? false, name, emoji ?? '🤖', color ?? '#6b7280',
      soul ?? '', command_name ?? null, harness_pattern ?? 'orchestrator', model ?? 'claude-sonnet-4-6',
    ]);

    return reply.code(201).send(await q1('SELECT * FROM agents WHERE id = ?', [id]));
  });

  app.patch('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;
    const body = req.body as Record<string, unknown>;
    const { id } = body;
    if (!id) return reply.code(400).send({ error: 'id required' });

    const existing = await q1('SELECT id FROM agents WHERE id = ? AND org_id = ?', [id as string, user.orgId]);
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    const fields = ['name','emoji','color','soul','command_name','harness_pattern','model','org_level','is_lead','team_id','part_id'];
    await Promise.all(fields
      .filter(f => body[f] !== undefined)
      .map(f => exec(`UPDATE agents SET ${f} = ? WHERE id = ?`, [body[f], id as string]))
    );

    return q1('SELECT * FROM agents WHERE id = ?', [id as string]);
  });

  app.delete('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;
    const { id } = req.body as { id: string };
    await exec('DELETE FROM agents WHERE id = ? AND org_id = ?', [id, user.orgId]);
    return { ok: true };
  });
}
