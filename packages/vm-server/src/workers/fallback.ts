/**
 * Fallback Daemon — executes trigger_type='scheduled' tasks via Anthropic SDK.
 * Runs inside the vm-server process. Uses FOR UPDATE SKIP LOCKED for safe concurrent polling.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getPool, exec, now } from '../db/pool.js';

const POLL_INTERVAL_MS = Number(process.env.FALLBACK_POLL_MS) || 5_000;
const FALLBACK_HOST_ID = 'fallback-daemon';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

type TaskRow = {
  id: string;
  org_id: string;
  title: string;
  description: string;
  agent_name: string | null;
};

let running = false;

async function claimTask(): Promise<TaskRow | undefined> {
  const result = await getPool().query<TaskRow>(`
    UPDATE tasks SET status = 'assigned', assigned_host_id = $1
    WHERE id = (
      SELECT id FROM tasks
      WHERE status = 'pending' AND trigger_type = 'scheduled'
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, org_id, title, description, agent_name
  `, [FALLBACK_HOST_ID]);
  return result.rows[0];
}

async function runTask(client: Anthropic, task: TaskRow): Promise<void> {
  await exec('UPDATE tasks SET status = $1, started_at = $2 WHERE id = $3',
    ['running', now(), task.id]);

  try {
    const prompt = task.description?.trim() || task.title;
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    await exec('UPDATE tasks SET status = $1, result = $2, finished_at = $3 WHERE id = $4',
      ['completed', text, now(), task.id]);

    console.log(`[fallback-daemon] task ${task.id} completed`);
  } catch (err) {
    await exec('UPDATE tasks SET status = $1, result = $2, finished_at = $3 WHERE id = $4',
      ['failed', String(err), now(), task.id]);
    console.error(`[fallback-daemon] task ${task.id} failed:`, err);
  }
}

async function poll(client: Anthropic): Promise<void> {
  if (running) return;
  running = true;
  try {
    const task = await claimTask();
    if (task) await runTask(client, task);
  } catch (err) {
    console.error('[fallback-daemon] poll error:', err);
  } finally {
    running = false;
  }
}

export function startFallbackDaemon(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[fallback-daemon] ANTHROPIC_API_KEY not set — fallback daemon disabled');
    return;
  }
  const client = new Anthropic();
  setInterval(() => poll(client), POLL_INTERVAL_MS);
  console.log(`[fallback-daemon] started (poll interval ${POLL_INTERVAL_MS}ms)`);
}
