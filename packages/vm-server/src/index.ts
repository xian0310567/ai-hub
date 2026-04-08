import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { authRoutes } from './routes/auth.js';
import { orgRoutes } from './routes/orgs.js';
import { divisionRoutes } from './routes/divisions.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { teamRoutes } from './routes/teams.js';
import { agentRoutes } from './routes/agents.js';
import { hostRoutes } from './routes/hosts.js';
import { taskRoutes } from './routes/tasks.js';
import { vaultRoutes } from './routes/vaults.js';
import { auditRoutes } from './routes/audit.js';
import { partRoutes } from './routes/parts.js';

const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '0.0.0.0';

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
});

await app.register(cookie, {
  secret: process.env.COOKIE_SECRET || 'change-me-in-production',
});

// 헬스체크
app.get('/health', async () => ({ status: 'ok', ts: Date.now() }));

// 라우트 등록
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

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`vm-server running on ${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
