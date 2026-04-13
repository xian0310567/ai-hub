/**
 * Cron Scheduler — reads the `schedules` table and creates tasks when due.
 * Runs inside the vm-server process.
 */

import cronParser from 'cron-parser';
import { getPool, exec, newId, now } from '../db/pool.js';

const SCHEDULER_INTERVAL_MS = Number(process.env.SCHEDULER_POLL_MS) || 60_000;

type ScheduleRow = {
  id: string;
  org_id: string;
  user_id: string | null;
  workspace_id: string | null;
  name: string;
  cron_expr: string;
  payload: string;
  next_run_at: number | null;
};

/** Compute next unix-second timestamp after `after` for the given cron expression. */
export function nextCronTs(cronExpr: string, after = new Date()): number {
  const interval = cronParser.parseExpression(cronExpr, { currentDate: after });
  return Math.floor(interval.next().getTime() / 1000);
}

async function tick(): Promise<void> {
  const ts = now();

  // Find all enabled schedules due to run
  const { rows: due } = await getPool().query<ScheduleRow>(`
    SELECT id, org_id, user_id, workspace_id, name, cron_expr, payload, next_run_at
    FROM schedules
    WHERE enabled = TRUE AND next_run_at IS NOT NULL AND next_run_at <= $1
  `, [ts]);

  for (const sched of due) {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(sched.payload); } catch { /* ignore */ }

    // Create a scheduled task
    const taskId = newId();
    const description = (payload.task as string) ?? (payload.description as string) ?? sched.name;
    await exec(`
      INSERT INTO tasks(id,org_id,triggered_by,title,description,trigger_type,required_vaults)
      VALUES($1,$2,$3,$4,$5,'scheduled','[]')
    `, [
      taskId,
      sched.org_id,
      sched.user_id,
      sched.name,
      description,
    ]);

    // Advance schedule
    const nextTs = nextCronTs(sched.cron_expr);
    await exec(
      'UPDATE schedules SET last_run_at = $1, next_run_at = $2 WHERE id = $3',
      [ts, nextTs, sched.id],
    );

    console.log(`[scheduler] schedule "${sched.name}" triggered → task ${taskId}, next at ${nextTs}`);
  }
}

export function startScheduler(): void {
  // Activate schedules that have no next_run_at yet
  void (async () => {
    try {
      const { rows } = await getPool().query<ScheduleRow>(`
        SELECT id, cron_expr FROM schedules WHERE enabled = TRUE AND next_run_at IS NULL
      `);
      for (const s of rows) {
        const nextTs = nextCronTs(s.cron_expr);
        await exec('UPDATE schedules SET next_run_at = $1 WHERE id = $2', [nextTs, s.id]);
      }
    } catch (err) {
      console.error('[scheduler] init error:', err);
    }
  })();

  setInterval(() => {
    tick().catch(err => console.error('[scheduler] tick error:', err));
  }, SCHEDULER_INTERVAL_MS);

  console.log(`[scheduler] started (interval ${SCHEDULER_INTERVAL_MS}ms)`);
}
