/**
 * Test database helper — clear all tables between tests.
 * Uses the same singleton `db` from schema.ts (shared in singleFork mode).
 */
import { db, newId } from '../../db/schema.js';
import crypto from 'crypto';

export { db };

/** Wipe all tables in safe FK order */
export function clearDb(): void {
  db.pragma('foreign_keys = OFF');
  db.exec(`
    DELETE FROM audit_logs;
    DELETE FROM vault_secrets;
    DELETE FROM workspace_vaults;
    DELETE FROM vaults;
    DELETE FROM schedules;
    DELETE FROM mission_jobs;
    DELETE FROM missions;
    DELETE FROM tasks;
    DELETE FROM chat_logs;
    DELETE FROM notifications;
    DELETE FROM team_members;
    DELETE FROM parts;
    DELETE FROM agents;
    DELETE FROM hosts;
    DELETE FROM teams;
    DELETE FROM workspaces;
    DELETE FROM divisions;
    DELETE FROM org_members;
    DELETE FROM sessions;
    DELETE FROM organizations;
    DELETE FROM users;
  `);
  db.pragma('foreign_keys = ON');
}

interface SeedResult {
  userId: string;
  orgId: string;
  sessionId: string;
  cookie: string;
}

/** Seed: create org + user + session, return ids and cookie header value */
export function seedUser(opts: {
  username?: string;
  password?: string;
  role?: string;
  orgSlug?: string;
} = {}): SeedResult {
  const username = opts.username ?? 'testuser';
  const role = opts.role ?? 'org_admin';
  const orgSlug = opts.orgSlug ?? 'testorg';

  // Create org if not exists
  let org = db.prepare('SELECT id FROM organizations WHERE slug = ?').get(orgSlug) as { id: string } | undefined;
  if (!org) {
    const orgId = newId();
    db.prepare('INSERT INTO organizations(id,name,slug) VALUES(?,?,?)').run(orgId, 'Test Org', orgSlug);
    org = { id: orgId };
  }

  // Create user
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(opts.password ?? 'password123', salt, 64).toString('hex');
  const userId = newId();
  db.prepare('INSERT OR IGNORE INTO users(id,username,password_hash) VALUES(?,?,?)').run(
    userId, username, `${salt}:${hash}`
  );
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: string };

  // Org membership
  db.prepare('INSERT OR IGNORE INTO org_members(id,org_id,user_id,role) VALUES(?,?,?,?)').run(
    newId(), org.id, user.id, role
  );

  // Session (30 day)
  const sessionId = newId();
  const expiresAt = Math.floor(Date.now() / 1000) + 86400 * 30;
  db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(sessionId, user.id, expiresAt);

  return {
    userId: user.id,
    orgId: org.id,
    sessionId,
    cookie: `session=${sessionId}`,
  };
}
