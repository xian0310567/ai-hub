import type { FastifyInstance } from 'fastify';
import { db, newId } from '../db/schema.js';
import { requireAuth } from '../db/auth.js';

export async function agentRoutes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { workspace_id, team_id } = req.query as { workspace_id?: string; team_id?: string };
    if (workspace_id) {
      return db.prepare('SELECT * FROM agents WHERE org_id = ? AND workspace_id = ? ORDER BY created_at').all(user.orgId, workspace_id);
    }
    if (team_id) {
      return db.prepare('SELECT * FROM agents WHERE org_id = ? AND team_id = ? ORDER BY created_at').all(user.orgId, team_id);
    }
    return db.prepare('SELECT * FROM agents WHERE org_id = ? ORDER BY created_at').all(user.orgId);
  });

  app.get('/:id', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND org_id = ?').get(id, user.orgId);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    return agent;
  });

  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { workspace_id, team_id, part_id, parent_agent_id, org_level, is_lead,
            name, emoji, color, soul, command_name, harness_pattern, model } = req.body as {
      workspace_id: string; team_id?: string; part_id?: string; parent_agent_id?: string;
      org_level?: string; is_lead?: boolean; name: string; emoji?: string; color?: string;
      soul?: string; command_name?: string; harness_pattern?: string; model?: string;
    };
    if (!workspace_id || !name) return reply.code(400).send({ error: 'workspace_id and name required' });

    const id = newId();
    db.prepare(`
      INSERT INTO agents(id,org_id,workspace_id,team_id,part_id,parent_agent_id,org_level,is_lead,name,emoji,color,soul,command_name,harness_pattern,model)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, user.orgId, workspace_id, team_id ?? null, part_id ?? null, parent_agent_id ?? null,
           org_level ?? 'worker', is_lead ? 1 : 0, name, emoji ?? '🤖', color ?? '#6b7280',
           soul ?? '', command_name ?? null, harness_pattern ?? 'orchestrator', model ?? 'claude-sonnet-4-5');

    return reply.code(201).send(db.prepare('SELECT * FROM agents WHERE id = ?').get(id));
  });

  app.patch('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const body = req.body as Record<string, unknown>;
    const { id } = body;
    if (!id) return reply.code(400).send({ error: 'id required' });

    const existing = db.prepare('SELECT id FROM agents WHERE id = ? AND org_id = ?').get(id as string, user.orgId);
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    const fields = ['name','emoji','color','soul','command_name','harness_pattern','model','org_level','is_lead','team_id','part_id'];
    for (const field of fields) {
      if (body[field] !== undefined) {
        db.prepare(`UPDATE agents SET ${field} = ? WHERE id = ?`).run(body[field] as string, id as string);
      }
    }
    return db.prepare('SELECT * FROM agents WHERE id = ?').get(id as string);
  });

  app.delete('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id } = req.body as { id: string };
    db.prepare('DELETE FROM agents WHERE id = ? AND org_id = ?').run(id, user.orgId);
    return { ok: true };
  });
}
