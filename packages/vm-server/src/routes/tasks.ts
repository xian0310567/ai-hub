import type { FastifyInstance } from 'fastify';
import { q1, qall, exec, buildWhere, newId, now } from '../db/pool.js';
import { requireAuth } from '../db/auth.js';

export async function taskRoutes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { host_id, status, trigger_type } = req.query as {
      host_id?: string; status?: string; trigger_type?: string;
    };

    const [sql, params] = buildWhere(
      'SELECT * FROM tasks WHERE org_id = $1',
      [user.orgId],
      [
        host_id ? ['preferred_host_id = ?', host_id] : null,
        status ? ['status = ?', status] : null,
        trigger_type ? ['trigger_type = ?', trigger_type] : null,
      ],
    );
    return qall(`${sql} ORDER BY created_at DESC LIMIT 100`, params);
  });

  // ── Pull 폴링 엔드포인트 ────────────────────────────────────────────
  // trigger_type = 'interactive'  → 사용자 PC 데몬 (host_id 필수)
  // trigger_type = 'scheduled'    → Fallback 데몬 (host_id = 'fallback-daemon')
  app.post('/poll', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { host_id, trigger_type } = req.body as { host_id: string; trigger_type?: string };
    if (!host_id) return reply.code(400).send({ error: 'host_id required' });

    const targetTrigger = trigger_type ?? 'interactive';

    // SELECT ... FOR UPDATE SKIP LOCKED: 동시 폴링 시 중복 취득 방지
    const result = await getPool_().query(`
      UPDATE tasks SET status = 'assigned', assigned_host_id = $1
      WHERE id = (
        SELECT id FROM tasks
        WHERE org_id = $2 AND status = 'pending' AND trigger_type = $3
          AND (preferred_host_id = $1 OR preferred_host_id IS NULL)
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `, [host_id, user.orgId, targetTrigger]);

    if (!result.rows.length) return { task: null };
    return { task: result.rows[0] };
  });

  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const {
      agent_id, agent_name, title, description, trigger_type,
      preferred_host_id, required_vaults, deadline, max_retries,
    } = req.body as {
      agent_id?: string; agent_name?: string; title: string; description?: string;
      trigger_type?: string; preferred_host_id?: string; required_vaults?: string[];
      deadline?: number; max_retries?: number;
    };
    if (!title) return reply.code(400).send({ error: 'title required' });

    const id = newId();
    await exec(`
      INSERT INTO tasks(id,org_id,triggered_by,agent_id,agent_name,title,description,
        trigger_type,preferred_host_id,required_vaults,deadline,max_retries)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      id, user.orgId, user.userId, agent_id ?? null, agent_name ?? null, title,
      description ?? '', trigger_type ?? 'interactive', preferred_host_id ?? null,
      JSON.stringify(required_vaults ?? []), deadline ?? null, max_retries ?? 2,
    ]);

    return reply.code(201).send(await q1('SELECT * FROM tasks WHERE id = ?', [id]));
  });

  app.patch('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id, status, result, assigned_host_id } = req.body as {
      id: string; status?: string; result?: string; assigned_host_id?: string;
    };
    if (!id) return reply.code(400).send({ error: 'id required' });

    const ts = now();
    if (status === 'running')
      await exec('UPDATE tasks SET status = ?, started_at = ? WHERE id = ?', [status, ts, id]);
    else if (status === 'completed' || status === 'failed')
      await exec('UPDATE tasks SET status = ?, result = ?, finished_at = ? WHERE id = ?', [status, result ?? '', ts, id]);
    else if (status)
      await exec('UPDATE tasks SET status = ? WHERE id = ?', [status, id]);

    if (result !== undefined && !status)
      await exec('UPDATE tasks SET result = ? WHERE id = ?', [result, id]);
    if (assigned_host_id !== undefined)
      await exec('UPDATE tasks SET assigned_host_id = ? WHERE id = ?', [assigned_host_id, id]);

    return q1('SELECT * FROM tasks WHERE id = ?', [id]);
  });

  app.delete('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id } = req.body as { id: string };
    await exec('DELETE FROM tasks WHERE id = ? AND org_id = ?', [id, user.orgId]);
    return { ok: true };
  });
}

// 내부용: FOR UPDATE SKIP LOCKED 쿼리에 pool 직접 사용
import { getPool } from '../db/pool.js';
function getPool_() { return getPool(); }
