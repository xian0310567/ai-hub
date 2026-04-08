/**
 * Webhook endpoint — verifies HMAC-SHA256 signature and creates a scheduled task.
 *
 * Header: X-Hub-Signature-256: sha256=<hex>
 * Body:   { event: string; payload?: object }
 *
 * WEBHOOK_SECRET env var must be set.
 */

import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { exec, newId } from '../db/pool.js';
import { requireAuth } from '../db/auth.js';

function verifySignature(body: Buffer, signature: string): boolean {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export async function webhookRoutes(app: FastifyInstance) {
  // Public webhook endpoint (no session required) — signature-verified
  app.post('/incoming', {
    config: { rawBody: true },
  }, async (req, reply) => {
    const sig = req.headers['x-hub-signature-256'] as string | undefined;
    if (!sig) return reply.code(400).send({ error: 'Missing X-Hub-Signature-256 header' });

    const rawBody = (req as { rawBody?: Buffer }).rawBody;
    if (!rawBody) return reply.code(400).send({ error: 'Raw body unavailable' });

    if (!verifySignature(rawBody, sig)) return reply.code(401).send({ error: 'Invalid signature' });

    const { event, payload, org_id } = req.body as {
      event?: string; payload?: Record<string, unknown>; org_id?: string;
    };

    if (!org_id) return reply.code(400).send({ error: 'org_id required in payload' });

    const taskId = newId();
    await exec(`
      INSERT INTO tasks(id,org_id,triggered_by,title,description,trigger_type,required_vaults)
      VALUES($1,$2,NULL,$3,$4,'scheduled','[]')
    `, [
      taskId,
      org_id,
      `webhook:${event ?? 'unknown'}`,
      JSON.stringify(payload ?? {}),
    ]);

    return reply.code(202).send({ ok: true, task_id: taskId });
  });

  // Authenticated: manage webhook secrets for an org
  app.get('/secret', async (req, reply) => {
    await requireAuth(req, reply);
    return {
      hint: 'Set WEBHOOK_SECRET env var on the server. Send X-Hub-Signature-256: sha256=<hmac> with your POST.',
    };
  });
}
