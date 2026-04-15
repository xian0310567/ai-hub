import type { FastifyInstance } from 'fastify';
import { qall, q1, exec, execReturning, newId, now } from '../db/pool.js';
import { requireAuth } from '../db/auth.js';
import { nextCronTs } from '../workers/scheduler.js';

export async function scheduleRoutes(app: FastifyInstance) {
  // GET / — org별 스케줄 목록
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    return qall(
      'SELECT * FROM schedules WHERE org_id = $1 ORDER BY created_at DESC',
      [user.orgId],
    );
  });

  // POST / — 스케줄 생성
  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { name, cron_expr, payload, workspace_id } = req.body as {
      name: string; cron_expr: string; payload?: string; workspace_id?: string;
    };

    if (!name || !cron_expr) {
      return reply.code(400).send({ error: 'name, cron_expr 필수' });
    }

    let next_run_at: number;
    try {
      next_run_at = nextCronTs(cron_expr);
    } catch {
      return reply.code(400).send({ error: '잘못된 cron 표현식' });
    }

    const id = newId();
    await exec(
      `INSERT INTO schedules(id, org_id, user_id, workspace_id, name, cron_expr, payload, next_run_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, user.orgId, user.userId, workspace_id ?? null, name, cron_expr, payload ?? '{}', next_run_at],
    );

    return execReturning('SELECT * FROM schedules WHERE id = $1', [id]);
  });

  // PATCH / — 스케줄 수정
  app.patch('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id, name, cron_expr, enabled } = req.body as {
      id: string; name?: string; cron_expr?: string; enabled?: boolean;
    };

    if (!id) return reply.code(400).send({ error: 'id 필수' });

    const sched = await q1<{ org_id: string }>('SELECT org_id FROM schedules WHERE id = $1', [id]);
    if (!sched || sched.org_id !== user.orgId) {
      return reply.code(404).send({ error: '없음' });
    }

    if (name !== undefined) {
      await exec('UPDATE schedules SET name = $1 WHERE id = $2', [name, id]);
    }

    if (enabled !== undefined) {
      await exec('UPDATE schedules SET enabled = $1 WHERE id = $2', [enabled, id]);
      if (enabled) {
        // 활성화 시 next_run_at 재계산
        const row = await q1<{ cron_expr: string }>('SELECT cron_expr FROM schedules WHERE id = $1', [id]);
        if (row) {
          const nxt = nextCronTs(row.cron_expr);
          await exec('UPDATE schedules SET next_run_at = $1 WHERE id = $2', [nxt, id]);
        }
      }
    }

    if (cron_expr !== undefined) {
      let nxt: number;
      try { nxt = nextCronTs(cron_expr); } catch {
        return reply.code(400).send({ error: '잘못된 cron 표현식' });
      }
      await exec('UPDATE schedules SET cron_expr = $1, next_run_at = $2 WHERE id = $3', [cron_expr, nxt, id]);
    }

    return execReturning('SELECT * FROM schedules WHERE id = $1', [id]);
  });

  // DELETE / — 스케줄 삭제
  app.delete('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { id } = req.body as { id: string };

    if (!id) return reply.code(400).send({ error: 'id 필수' });

    const sched = await q1<{ org_id: string }>('SELECT org_id FROM schedules WHERE id = $1', [id]);
    if (!sched || sched.org_id !== user.orgId) {
      return reply.code(404).send({ error: '없음' });
    }

    await exec('DELETE FROM schedules WHERE id = $1', [id]);
    return { ok: true };
  });
}
