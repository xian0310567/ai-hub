import type { FastifyInstance } from 'fastify';
import { db, newId } from '../db/schema.js';
import { requireAuth } from '../db/auth.js';

export async function taskRoutes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { host_id, status, trigger_type } = req.query as {
      host_id?: string; status?: string; trigger_type?: string;
    };

    let query = 'SELECT * FROM tasks WHERE org_id = ?';
    const params: unknown[] = [user.orgId];

    if (host_id) { query += ' AND preferred_host_id = ?'; params.push(host_id); }
    if (status) { query += ' AND status = ?'; params.push(status); }
    if (trigger_type) { query += ' AND trigger_type = ?'; params.push(trigger_type); }

    query += ' ORDER BY created_at DESC LIMIT 100';
    return db.prepare(query).all(...params);
  });

  // 데몬이 자신의 호스트로 라우팅된 작업을 가져가는 엔드포인트 (Pull 방식)
  app.post('/poll', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { host_id, trigger_type } = req.body as { host_id: string; trigger_type?: string };
    if (!host_id) return reply.code(400).send({ error: 'host_id required' });

    const targetTrigger = trigger_type ?? 'interactive';

    const task = db.prepare(`
      SELECT * FROM tasks
      WHERE org_id = ? AND status = 'pending'
        AND trigger_type = ?
        AND (preferred_host_id = ? OR preferred_host_id IS NULL)
      ORDER BY created_at
      LIMIT 1
    `).get(user.orgId, targetTrigger, host_id) as { id: string } | undefined;

    if (!task) return { task: null };

    // assigned로 변경
    db.prepare('UPDATE tasks SET status = ?, assigned_host_id = ? WHERE id = ?').run('assigned', host_id, task.id);
    return { task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) };
  });

  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { agent_id, agent_name, title, description, trigger_type, preferred_host_id, required_vaults, deadline, max_retries } = req.body as {
      agent_id?: string; agent_name?: string; title: string; description?: string;
      trigger_type?: string; preferred_host_id?: string; required_vaults?: string[];
      deadline?: number; max_retries?: number;
    };
    if (!title) return reply.code(400).send({ error: 'title required' });

    const id = newId();
    db.prepare(`
      INSERT INTO tasks(id,org_id,triggered_by,agent_id,agent_name,title,description,trigger_type,preferred_host_id,required_vaults,deadline,max_retries)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, user.orgId, user.userId, agent_id ?? null, agent_name ?? null, title,
           description ?? '', trigger_type ?? 'interactive', preferred_host_id ?? null,
           JSON.stringify(required_vaults ?? []), deadline ?? null, max_retries ?? 2);

    return reply.code(201).send(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  });

  app.patch('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id, status, result, assigned_host_id } = req.body as {
      id: string; status?: string; result?: string; assigned_host_id?: string;
    };
    if (!id) return reply.code(400).send({ error: 'id required' });

    const now = Math.floor(Date.now() / 1000);
    if (status === 'running') db.prepare('UPDATE tasks SET status = ?, started_at = ? WHERE id = ?').run(status, now, id);
    else if (status === 'completed' || status === 'failed') db.prepare('UPDATE tasks SET status = ?, result = ?, finished_at = ? WHERE id = ?').run(status, result ?? '', now, id);
    else if (status) db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id);
    if (result !== undefined && !status) db.prepare('UPDATE tasks SET result = ? WHERE id = ?').run(result, id);
    if (assigned_host_id !== undefined) db.prepare('UPDATE tasks SET assigned_host_id = ? WHERE id = ?').run(assigned_host_id, id);

    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  });

  app.delete('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id } = req.body as { id: string };
    db.prepare('DELETE FROM tasks WHERE id = ? AND org_id = ?').run(id, user.orgId);
    return { ok: true };
  });
}
