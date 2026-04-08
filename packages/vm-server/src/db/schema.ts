import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'vm.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- ───────────────────────────────────────────
  -- 사용자 (개인 계정, 어느 org에든 소속 가능)
  -- ───────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- ───────────────────────────────────────────
  -- 조직 (테넌트 단위 - SaaS 기준 workspace)
  -- ───────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS organizations (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    slug       TEXT UNIQUE NOT NULL,  -- URL 식별자
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- 사용자 ↔ 조직 멤버십 + 역할
  -- role: org_admin | team_admin | member
  CREATE TABLE IF NOT EXISTS org_members (
    id         TEXT PRIMARY KEY,
    org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL DEFAULT 'member',
    joined_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(org_id, user_id)
  );

  -- ───────────────────────────────────────────
  -- 조직 계층 (org_id로 격리, user_id 없음)
  -- Division → Workspace(부서) → Team → Part → Agent
  -- ───────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS divisions (
    id            TEXT PRIMARY KEY,
    org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    color         TEXT NOT NULL DEFAULT '#6b7280',
    ws_path       TEXT NOT NULL DEFAULT '',
    order_index   INTEGER NOT NULL DEFAULT 0,
    harness_prompt TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id            TEXT PRIMARY KEY,
    org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    division_id   TEXT REFERENCES divisions(id) ON DELETE SET NULL,
    name          TEXT NOT NULL,
    path          TEXT NOT NULL,
    order_index   INTEGER NOT NULL DEFAULT 0,
    harness_prompt TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS teams (
    id            TEXT PRIMARY KEY,
    org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    color         TEXT NOT NULL DEFAULT '#6b7280',
    order_index   INTEGER NOT NULL DEFAULT 0,
    harness_prompt TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- 팀 멤버십 (어떤 사용자가 어떤 팀에 속하는지)
  -- role: team_admin | member
  CREATE TABLE IF NOT EXISTS team_members (
    id        TEXT PRIMARY KEY,
    team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      TEXT NOT NULL DEFAULT 'member',
    joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(team_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS parts (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT '#6b7280',
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS agents (
    id              TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    workspace_id    TEXT,  -- workspace 또는 division ID (division 에이전트는 division ID 저장, FK 없음)
    team_id         TEXT REFERENCES teams(id) ON DELETE SET NULL,
    part_id         TEXT REFERENCES parts(id) ON DELETE SET NULL,
    parent_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    org_level       TEXT NOT NULL DEFAULT 'worker',
    is_lead         INTEGER NOT NULL DEFAULT 0,
    name            TEXT NOT NULL,
    emoji           TEXT NOT NULL DEFAULT '🤖',
    color           TEXT NOT NULL DEFAULT '#6b7280',
    soul            TEXT NOT NULL DEFAULT '',
    command_name    TEXT,
    harness_pattern TEXT NOT NULL DEFAULT 'orchestrator',
    model           TEXT NOT NULL DEFAULT 'claude-sonnet-4-5',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- ───────────────────────────────────────────
  -- 작업 큐 (triggered_by = 누가 시작했는가)
  -- ───────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS tasks (
    id            TEXT PRIMARY KEY,
    org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    triggered_by  TEXT NOT NULL REFERENCES users(id),
    agent_id      TEXT REFERENCES agents(id) ON DELETE SET NULL,
    agent_name    TEXT,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    trigger_type  TEXT NOT NULL DEFAULT 'interactive', -- interactive | scheduled | event
    preferred_host_id TEXT,                            -- 인터랙티브: 보낸 사람 호스트
    assigned_host_id  TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',     -- pending | assigned | running | completed | failed | expired
    required_vaults TEXT NOT NULL DEFAULT '[]',        -- JSON array of vault IDs
    result        TEXT NOT NULL DEFAULT '',
    deadline      INTEGER,
    retry_count   INTEGER NOT NULL DEFAULT 0,
    max_retries   INTEGER NOT NULL DEFAULT 2,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    started_at    INTEGER,
    finished_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS missions (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    triggered_by TEXT NOT NULL REFERENCES users(id),
    task         TEXT NOT NULL,
    routing      TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'pending',
    steps        TEXT NOT NULL DEFAULT '[]',
    final_doc    TEXT NOT NULL DEFAULT '',
    images       TEXT NOT NULL DEFAULT '[]',
    created_at   INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS mission_jobs (
    id          TEXT PRIMARY KEY,
    mission_id  TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    agent_name  TEXT NOT NULL,
    prompt      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed
    result      TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    started_at  INTEGER,
    finished_at INTEGER
  );

  -- ───────────────────────────────────────────
  -- 호스트 (사용자 PC 데몬 등록)
  -- ───────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS hosts (
    id            TEXT PRIMARY KEY,
    org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'offline', -- idle | busy | draining | offline
    last_heartbeat INTEGER,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- ───────────────────────────────────────────
  -- Vault (시크릿 관리 - org/team 스코프)
  -- personal vault는 사용자 PC에만 존재, 여기엔 메타데이터만
  -- ───────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS vaults (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    scope       TEXT NOT NULL DEFAULT 'org', -- org | team | personal_meta
    team_id     TEXT REFERENCES teams(id) ON DELETE CASCADE,
    owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE, -- personal_meta 전용
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    expires_at  INTEGER,  -- 만료 예정일 알림용
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- 암호화된 시크릿 (org/team vault만 실제 값 저장)
  -- envelope encryption: DEK으로 값 암호화, KEK으로 DEK 암호화
  CREATE TABLE IF NOT EXISTS vault_secrets (
    id               TEXT PRIMARY KEY,
    vault_id         TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    key_name         TEXT NOT NULL,             -- e.g. "IG_ACCESS_TOKEN"
    encrypted_value  TEXT NOT NULL,             -- AES-256-GCM 암호화된 값
    encrypted_dek    TEXT NOT NULL,             -- KEK으로 암호화된 DEK
    iv               TEXT NOT NULL,
    auth_tag         TEXT NOT NULL,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(vault_id, key_name)
  );

  -- 워크스페이스 ↔ Vault 매핑
  CREATE TABLE IF NOT EXISTS workspace_vaults (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    vault_id     TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    attached_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(workspace_id, vault_id)
  );

  -- ───────────────────────────────────────────
  -- Audit Log (1일차부터)
  -- ───────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS audit_logs (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
    host_id      TEXT REFERENCES hosts(id) ON DELETE SET NULL,
    action       TEXT NOT NULL,   -- vault.lease | task.create | member.add 등
    resource     TEXT NOT NULL,   -- 대상 리소스 타입
    resource_id  TEXT NOT NULL,   -- 대상 리소스 ID
    meta         TEXT NOT NULL DEFAULT '{}', -- JSON 추가 정보
    created_at   INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- ───────────────────────────────────────────
  -- 개인 데이터 (user_id 유지)
  -- ───────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS chat_logs (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id     TEXT REFERENCES organizations(id) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    title      TEXT NOT NULL,
    message    TEXT NOT NULL,
    read       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- ───────────────────────────────────────────
  -- 스케줄 (워크스페이스 단위 cron)
  -- ───────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS schedules (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    cron_expr    TEXT NOT NULL,
    payload      TEXT NOT NULL DEFAULT '{}',
    enabled      INTEGER NOT NULL DEFAULT 1,
    last_run_at  INTEGER,
    next_run_at  INTEGER,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- ───────────────────────────────────────────
  -- 시스템 설정
  -- ───────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ─────────────────────────────────────────────────────
// 마이그레이션: agents.workspace_id FK 제약 제거
// (division 에이전트는 workspace 대신 division ID를 workspace_id에 저장)
// ─────────────────────────────────────────────────────
{
  const hasFk = (db.prepare('PRAGMA foreign_key_list(agents)').all() as Array<{from: string}>)
    .some(fk => fk.from === 'workspace_id');

  if (hasFk) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE agents_new (
        id              TEXT PRIMARY KEY,
        org_id          TEXT NOT NULL,
        workspace_id    TEXT,
        team_id         TEXT,
        part_id         TEXT,
        parent_agent_id TEXT,
        org_level       TEXT NOT NULL DEFAULT 'worker',
        is_lead         INTEGER NOT NULL DEFAULT 0,
        name            TEXT NOT NULL,
        emoji           TEXT NOT NULL DEFAULT '🤖',
        color           TEXT NOT NULL DEFAULT '#6b7280',
        soul            TEXT NOT NULL DEFAULT '',
        command_name    TEXT,
        harness_pattern TEXT NOT NULL DEFAULT 'orchestrator',
        model           TEXT NOT NULL DEFAULT 'claude-sonnet-4-5',
        created_at      INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    db.exec(`INSERT OR IGNORE INTO agents_new SELECT * FROM agents`);
    db.exec(`DROP TABLE agents`);
    db.exec(`ALTER TABLE agents_new RENAME TO agents`);
    db.pragma('foreign_keys = ON');
    console.log('[schema] agents 테이블 마이그레이션 완료 (workspace_id FK 제거)');
  }
}

// ─────────────────────────────────────────────────────
// 유틸: 서버 시작 시 crashed 작업 정리
// ─────────────────────────────────────────────────────
db.prepare(`
  UPDATE tasks SET status='failed' WHERE status IN ('running','assigned')
`).run();

db.prepare(`
  UPDATE mission_jobs SET status='failed' WHERE status='running'
`).run();

// ─────────────────────────────────────────────────────
// ID 생성
// ─────────────────────────────────────────────────────
export const newId = () => crypto.randomUUID();
