/**
 * PostgreSQL 스키마 초기화
 *
 * initSchema()를 서버 시작 시 1회 호출한다.
 * pg-mem 테스트 환경에서도 동일하게 사용한다.
 *
 * ⚠️  pg-mem은 멀티-스테이트먼트 쿼리를 지원하지 않으므로
 *     CREATE TABLE을 개별 pool.query() 호출로 분리한다.
 */

import { getPool } from './pool.js';

export async function initSchema(): Promise<void> {
  const pool = getPool();

  const tables: string[] = [
    // ── 기본 테이블 ──────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )`,

    `CREATE TABLE IF NOT EXISTS organizations (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      slug       TEXT UNIQUE NOT NULL,
      created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )`,

    `CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      org_id     TEXT REFERENCES organizations(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )`,

    `CREATE TABLE IF NOT EXISTS org_members (
      id        TEXT PRIMARY KEY,
      org_id    TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role      TEXT NOT NULL DEFAULT 'member',
      joined_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(org_id, user_id)
    )`,

    `CREATE TABLE IF NOT EXISTS divisions (
      id             TEXT PRIMARY KEY,
      org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      color          TEXT NOT NULL DEFAULT '#6b7280',
      ws_path        TEXT NOT NULL DEFAULT '',
      order_index    INTEGER NOT NULL DEFAULT 0,
      harness_prompt TEXT NOT NULL DEFAULT '',
      created_at     BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )`,

    `CREATE TABLE IF NOT EXISTS workspaces (
      id             TEXT PRIMARY KEY,
      org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      division_id    TEXT REFERENCES divisions(id) ON DELETE SET NULL,
      name           TEXT NOT NULL,
      path           TEXT NOT NULL,
      order_index    INTEGER NOT NULL DEFAULT 0,
      harness_prompt TEXT NOT NULL DEFAULT '',
      created_at     BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )`,

    `CREATE TABLE IF NOT EXISTS teams (
      id             TEXT PRIMARY KEY,
      org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      description    TEXT NOT NULL DEFAULT '',
      color          TEXT NOT NULL DEFAULT '#6b7280',
      order_index    INTEGER NOT NULL DEFAULT 0,
      harness_prompt TEXT NOT NULL DEFAULT '',
      created_at     BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )`,

    `CREATE TABLE IF NOT EXISTS team_members (
      id        TEXT PRIMARY KEY,
      team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role      TEXT NOT NULL DEFAULT 'member',
      joined_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(team_id, user_id)
    )`,

    `CREATE TABLE IF NOT EXISTS parts (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      color       TEXT NOT NULL DEFAULT '#6b7280',
      order_index INTEGER NOT NULL DEFAULT 0,
      created_at  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )`,

    `CREATE TABLE IF NOT EXISTS agents (
      id              TEXT PRIMARY KEY,
      org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      workspace_id    TEXT,
      team_id         TEXT REFERENCES teams(id) ON DELETE SET NULL,
      part_id         TEXT REFERENCES parts(id) ON DELETE SET NULL,
      parent_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      org_level       TEXT NOT NULL DEFAULT 'worker',
      is_lead         BOOLEAN NOT NULL DEFAULT FALSE,
      name            TEXT NOT NULL,
      emoji           TEXT NOT NULL DEFAULT '🤖',
      color           TEXT NOT NULL DEFAULT '#6b7280',
      soul            TEXT NOT NULL DEFAULT '',
      command_name    TEXT,
      harness_pattern TEXT NOT NULL DEFAULT 'orchestrator',
      model           TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
      created_at      BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )`,

    // ── 작업 큐 ──────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS tasks (
      id                TEXT PRIMARY KEY,
      org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      triggered_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
      agent_id          TEXT REFERENCES agents(id) ON DELETE SET NULL,
      agent_name        TEXT,
      title             TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      trigger_type      TEXT NOT NULL DEFAULT 'interactive',
      preferred_host_id TEXT,
      assigned_host_id  TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      required_vaults   TEXT NOT NULL DEFAULT '[]',
      result            TEXT NOT NULL DEFAULT '',
      deadline          BIGINT,
      retry_count       INTEGER NOT NULL DEFAULT 0,
      max_retries       INTEGER NOT NULL DEFAULT 2,
      created_at        BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      started_at        BIGINT,
      finished_at       BIGINT
    )`,

    `CREATE TABLE IF NOT EXISTS missions (
      id           TEXT PRIMARY KEY,
      org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      triggered_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      task         TEXT NOT NULL,
      routing      TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'pending',
      steps        TEXT NOT NULL DEFAULT '[]',
      final_doc    TEXT NOT NULL DEFAULT '',
      images       TEXT NOT NULL DEFAULT '[]',
      created_at   BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )`,

    `CREATE TABLE IF NOT EXISTS mission_jobs (
      id          TEXT PRIMARY KEY,
      mission_id  TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      agent_name  TEXT NOT NULL,
      prompt      TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'queued',
      result      TEXT NOT NULL DEFAULT '',
      created_at  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      started_at  BIGINT,
      finished_at BIGINT
    )`,

    // ── 호스트 + Vault ────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS hosts (
      id             TEXT PRIMARY KEY,
      org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'offline',
      last_heartbeat BIGINT,
      created_at     BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )`,

    `CREATE TABLE IF NOT EXISTS vaults (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      scope         TEXT NOT NULL DEFAULT 'org',
      team_id       TEXT REFERENCES teams(id) ON DELETE CASCADE,
      owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      expires_at    BIGINT,
      created_at    BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )`,

    `CREATE TABLE IF NOT EXISTS vault_secrets (
      id              TEXT PRIMARY KEY,
      vault_id        TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      key_name        TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      encrypted_dek   TEXT NOT NULL,
      iv              TEXT NOT NULL,
      auth_tag        TEXT NOT NULL,
      created_at      BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      updated_at      BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(vault_id, key_name)
    )`,

    `CREATE TABLE IF NOT EXISTS workspace_vaults (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      vault_id     TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      attached_at  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(workspace_id, vault_id)
    )`,

    // ── 스케줄 / 로그 / 알림 ──────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS schedules (
      id           TEXT PRIMARY KEY,
      org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      cron_expr    TEXT NOT NULL,
      payload      TEXT NOT NULL DEFAULT '{}',
      enabled      BOOLEAN NOT NULL DEFAULT TRUE,
      last_run_at  BIGINT,
      next_run_at  BIGINT,
      created_at   BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )`,

    `CREATE TABLE IF NOT EXISTS audit_logs (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
      host_id     TEXT REFERENCES hosts(id) ON DELETE SET NULL,
      action      TEXT NOT NULL,
      resource    TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      meta        TEXT NOT NULL DEFAULT '{}',
      created_at  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )`,

    `CREATE TABLE IF NOT EXISTS chat_logs (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )`,

    `CREATE TABLE IF NOT EXISTS notifications (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      org_id     TEXT REFERENCES organizations(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      title      TEXT NOT NULL,
      message    TEXT NOT NULL,
      read       BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )`,

    `CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,

    // ── OpenClaw 채널 설정 ────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS openclaw_channels (
      id              TEXT PRIMARY KEY,
      org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      channel_type    TEXT NOT NULL,
      config          TEXT NOT NULL DEFAULT '{}',
      enabled         BOOLEAN NOT NULL DEFAULT TRUE,
      target_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      created_at      BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(org_id, channel_type)
    )`,

    // ── OpenClaw 워크스페이스 설정 (DB 기반 동적 생성) ──────────────────
    `CREATE TABLE IF NOT EXISTS openclaw_configs (
      id           TEXT PRIMARY KEY,
      org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      config       TEXT NOT NULL DEFAULT '{}',
      runtime_dir  TEXT NOT NULL DEFAULT '',
      version      INTEGER NOT NULL DEFAULT 1,
      updated_at   BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(org_id)
    )`,
  ];

  for (const ddl of tables) {
    await pool.query(ddl);
  }

  // 마이그레이션: schedules에 user_id 추가
  await pool.query(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL`);

  // 서버 재시작 시 running/assigned 상태 작업 정리
  await pool.query(`UPDATE tasks SET status = 'failed' WHERE status IN ('running', 'assigned')`);
}

// newId 재수출 (하위 호환)
export { newId } from './pool.js';
