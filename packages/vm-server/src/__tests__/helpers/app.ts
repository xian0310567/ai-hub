/**
 * Build a test Fastify app with all routes registered.
 * Re-used across test files.
 *
 * Initialises an in-memory pg-mem database via setupTestDb() on first call.
 */
import Fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { setupTestDb } from './db.js';
import { authRoutes } from '../../routes/auth.js';
import { orgRoutes } from '../../routes/orgs.js';
import { divisionRoutes } from '../../routes/divisions.js';
import { workspaceRoutes } from '../../routes/workspaces.js';
import { teamRoutes } from '../../routes/teams.js';
import { agentRoutes } from '../../routes/agents.js';
import { hostRoutes } from '../../routes/hosts.js';
import { taskRoutes } from '../../routes/tasks.js';
import { vaultRoutes } from '../../routes/vaults.js';
import { auditRoutes } from '../../routes/audit.js';
import { partRoutes } from '../../routes/parts.js';

let dbInitialised = false;

export async function buildApp(): Promise<FastifyInstance> {
  if (!dbInitialised) {
    await setupTestDb();
    dbInitialised = true;
  }

  const app = Fastify({ logger: false });

  await app.register(cookie, {
    secret: process.env.COOKIE_SECRET || 'test-cookie-secret',
  });

  await app.register(authRoutes,      { prefix: '/api/auth' });
  await app.register(orgRoutes,       { prefix: '/api/orgs' });
  await app.register(divisionRoutes,  { prefix: '/api/divisions' });
  await app.register(workspaceRoutes, { prefix: '/api/workspaces' });
  await app.register(teamRoutes,      { prefix: '/api/teams' });
  await app.register(agentRoutes,     { prefix: '/api/agents' });
  await app.register(hostRoutes,      { prefix: '/api/hosts' });
  await app.register(taskRoutes,      { prefix: '/api/tasks' });
  await app.register(vaultRoutes,     { prefix: '/api/vaults' });
  await app.register(auditRoutes,     { prefix: '/api/audit' });
  await app.register(partRoutes,      { prefix: '/api/parts' });

  await app.ready();
  return app;
}
