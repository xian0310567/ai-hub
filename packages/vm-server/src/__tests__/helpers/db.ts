/**
 * Test database helper — pg-mem in-memory PostgreSQL for tests.
 *
 * Call setupTestDb() once in beforeAll, clearDb() in beforeEach.
 * seedUser() seeds org + user + session; returns ids and cookie string.
 */

import { newDb } from 'pg-mem';
import { setPool, getPool, newId } from '../../db/pool.js';
import { initSchema } from '../../db/schema.js';
import crypto from 'crypto';

export { newId };

// ── Setup ─────────────────────────────────────────────────────────────────

export async function setupTestDb(): Promise<void> {
  const mem = newDb();
  // createPg() returns a pg-compatible { Pool, Client } pair
  const { Pool } = mem.adapters.createPg();
  setPool(new Pool() as never);
  await initSchema();
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Direct query helper for test assertions */
export async function q1<T = Record<string, unknown>>(
  sql: string, params?: unknown[]
): Promise<T | undefined> {
  const { rows } = await getPool().query(sql, params);
  return rows[0] as T | undefined;
}

export async function qall<T = Record<string, unknown>>(
  sql: string, params?: unknown[]
): Promise<T[]> {
  const { rows } = await getPool().query(sql, params);
  return rows as T[];
}

// ── Clear ─────────────────────────────────────────────────────────────────

const DELETE_ORDER = [
  'audit_logs',
  'vault_secrets',
  'workspace_vaults',
  'vaults',
  'schedules',
  'mission_jobs',
  'missions',
  'tasks',
  'chat_logs',
  'notifications',
  'team_members',
  'parts',
  'openclaw_channels',
  'openclaw_configs',
  'agents',
  'hosts',
  'teams',
  'workspaces',
  'divisions',
  'org_members',
  'sessions',
  'organizations',
  'users',
];

export async function clearDb(): Promise<void> {
  const pool = getPool();
  for (const table of DELETE_ORDER) {
    await pool.query(`DELETE FROM ${table}`);
  }
}

// ── Seed ──────────────────────────────────────────────────────────────────

interface SeedResult {
  userId: string;
  orgId: string;
  sessionId: string;
  cookie: string;
}

export async function seedUser(opts: {
  username?: string;
  password?: string;
  role?: string;
  orgSlug?: string;
} = {}): Promise<SeedResult> {
  const pool = getPool();
  const username = opts.username ?? 'testuser';
  const role = opts.role ?? 'org_admin';
  const orgSlug = opts.orgSlug ?? 'testorg';

  // Create org if not exists
  let orgRow = (
    await pool.query<{ id: string }>('SELECT id FROM organizations WHERE slug = $1', [orgSlug])
  ).rows[0];
  if (!orgRow) {
    const orgId = newId();
    await pool.query(
      'INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3)',
      [orgId, 'Test Org', orgSlug],
    );
    orgRow = { id: orgId };
  }

  // Create user (or get existing)
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(opts.password ?? 'password123', salt, 64).toString('hex');
  const userId = newId();
  await pool.query(
    'INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [userId, username, `${salt}:${hash}`],
  );
  const user = (
    await pool.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [username])
  ).rows[0];

  // Org membership
  await pool.query(
    'INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [newId(), orgRow.id, user.id, role],
  );

  // Session (30 days, with org_id for auth)
  const sessionId = newId();
  const expiresAt = Math.floor(Date.now() / 1000) + 86400 * 30;
  await pool.query(
    'INSERT INTO sessions(id,user_id,org_id,expires_at) VALUES($1,$2,$3,$4)',
    [sessionId, user.id, orgRow.id, expiresAt],
  );

  return {
    userId: user.id,
    orgId: orgRow.id,
    sessionId,
    cookie: `session=${sessionId}`,
  };
}
