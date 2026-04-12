/**
 * electron-app 로컬 DB
 * 개인 데이터만 저장: chat_logs, notifications, missions(로컬 실행), mission_jobs
 * 공유 조직 데이터(divisions, workspaces, teams, agents 등)는 vm-server에 있음
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Next.js 핫 리로드 시 DB 인스턴스 재사용 (모듈 재평가 방지)
const globalDb = globalThis as unknown as { __localDb?: Database.Database; __localDbInitDone?: boolean };
if (!globalDb.__localDb) {
  globalDb.__localDb = new Database(path.join(DATA_DIR, 'local.db'));
  globalDb.__localDb.pragma('journal_mode = WAL');
  globalDb.__localDb.pragma('foreign_keys = ON');
}
const db = globalDb.__localDb;

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- 개인 대화 기록 (agent_id는 vm-server의 agents.id를 참조)
  CREATE TABLE IF NOT EXISTS chat_logs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    session_key TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- 개인 알림
  CREATE TABLE IF NOT EXISTS notifications (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'info',
    title      TEXT NOT NULL,
    message    TEXT NOT NULL,
    read       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- 미션 (로컬 Claude CLI 실행 단위)
  CREATE TABLE IF NOT EXISTS missions (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    task              TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    routing           TEXT NOT NULL DEFAULT '[]',
    steps             TEXT NOT NULL DEFAULT '[]',
    final_doc         TEXT NOT NULL DEFAULT '',
    images            TEXT NOT NULL DEFAULT '[]',
    parent_mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
    origin            TEXT NOT NULL DEFAULT 'user',
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- 미션 잡 큐 (에이전트별 순차 실행)
  CREATE TABLE IF NOT EXISTS mission_jobs (
    id              TEXT PRIMARY KEY,
    mission_id      TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    agent_id        TEXT NOT NULL,
    agent_name      TEXT NOT NULL,
    org_name        TEXT NOT NULL DEFAULT '',
    subtask         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'queued',
    gate_type       TEXT NOT NULL DEFAULT 'auto',
    gate_status     TEXT NOT NULL DEFAULT 'approved',
    quality_scores  TEXT,
    result          TEXT NOT NULL DEFAULT '',
    error           TEXT NOT NULL DEFAULT '',
    queued_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    started_at      INTEGER,
    finished_at     INTEGER
  );

  -- 미션 템플릿 (재사용 가능한 워크플로)
  CREATE TABLE IF NOT EXISTS mission_templates (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    task        TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '[]',
    is_builtin  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- MCP 서버 설정 (Claude CLI --mcp-config 연동)
  CREATE TABLE IF NOT EXISTS mcp_server_configs (
    id        TEXT PRIMARY KEY,
    user_id   TEXT NOT NULL,
    name      TEXT NOT NULL,
    label     TEXT NOT NULL DEFAULT '',
    command   TEXT NOT NULL,
    args      TEXT NOT NULL DEFAULT '[]',
    env_json  TEXT NOT NULL DEFAULT '{}',
    enabled   INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- 반복 미션 스케줄
  CREATE TABLE IF NOT EXISTS mission_schedules (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL,
    name           TEXT NOT NULL,
    cron_expr      TEXT NOT NULL,
    task           TEXT NOT NULL,
    routing        TEXT NOT NULL DEFAULT '[]',
    session_cookie TEXT NOT NULL DEFAULT '',
    enabled        INTEGER NOT NULL DEFAULT 1,
    last_run_at    INTEGER,
    next_run_at    INTEGER,
    created_at     INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

// 마이그레이션: 기존 DB에 신규 컬럼 추가 (이미 있으면 무시)
try { db.exec("ALTER TABLE missions ADD COLUMN parent_mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL"); } catch {}
try { db.exec("ALTER TABLE missions ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'"); } catch {}
try { db.exec("ALTER TABLE mission_jobs ADD COLUMN gate_type TEXT NOT NULL DEFAULT 'auto'"); } catch {}
try { db.exec("ALTER TABLE mission_jobs ADD COLUMN gate_status TEXT NOT NULL DEFAULT 'approved'"); } catch {}
try { db.exec("ALTER TABLE mission_jobs ADD COLUMN quality_scores TEXT"); } catch {}
try { db.exec("ALTER TABLE chat_logs ADD COLUMN session_key TEXT"); } catch {}
try { db.exec("ALTER TABLE mission_schedules ADD COLUMN openclaw_cron_id TEXT"); } catch {}
try { db.exec("ALTER TABLE missions ADD COLUMN error TEXT NOT NULL DEFAULT ''"); } catch {}

// 마이그레이션 후 session_key 인덱스 생성 (기존 DB에 session_key가 없을 때 db.exec 안에서 실패하는 것 방지)
try { db.exec("CREATE INDEX IF NOT EXISTS idx_chat_logs_user_session ON chat_logs(user_id, agent_id, session_key)"); } catch {}

// FTS5 가상 테이블 (chat_logs 전문 검색용)
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_logs_fts
    USING fts5(content, content=chat_logs, content_rowid=rowid);
  `);
  // content-sync 트리거
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chat_logs_ai AFTER INSERT ON chat_logs BEGIN
      INSERT INTO chat_logs_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chat_logs_ad AFTER DELETE ON chat_logs BEGIN
      INSERT INTO chat_logs_fts(chat_logs_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chat_logs_au AFTER UPDATE ON chat_logs BEGIN
      INSERT INTO chat_logs_fts(chat_logs_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO chat_logs_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);
  // 기존 데이터 FTS 인덱싱 (비어있을 때만)
  const ftsCount = (db.prepare('SELECT COUNT(*) as cnt FROM chat_logs_fts').get() as { cnt: number })?.cnt ?? 0;
  if (ftsCount === 0) {
    const logCount = (db.prepare('SELECT COUNT(*) as cnt FROM chat_logs').get() as { cnt: number })?.cnt ?? 0;
    if (logCount > 0) {
      db.exec('INSERT INTO chat_logs_fts(rowid, content) SELECT rowid, content FROM chat_logs');
    }
  }
} catch {}

// 서버 재시작 시 stuck 잡 정리 (핫 리로드 시 중복 실행 방지)
if (!globalDb.__localDbInitDone) {
  globalDb.__localDbInitDone = true;
  db.prepare("UPDATE missions SET status='failed' WHERE status IN ('analyzing','running')").run();
  db.prepare("UPDATE mission_jobs SET status='failed' WHERE status IN ('running','gate_pending')").run();
}

export default db;

// ── 헬퍼 ─────────────────────────────────────────────────────────────

export const Settings = {
  get: (key: string) => (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value,
  set: (key: string, value: string) => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, value),
};

export const ChatLogs = {
  list:  (userId: string, agentId: string, limit = 100) =>
    db.prepare('SELECT * FROM chat_logs WHERE user_id=? AND agent_id=? ORDER BY created_at DESC LIMIT ?').all(userId, agentId, limit).reverse() as ChatLog[],
  add:   (log: Omit<ChatLog, 'created_at'>) =>
    db.prepare('INSERT INTO chat_logs(id,user_id,agent_id,role,content,session_key) VALUES(?,?,?,?,?,?)').run(log.id, log.user_id, log.agent_id, log.role, log.content, log.session_key ?? null),
  clear: (userId: string, agentId: string) =>
    db.prepare('DELETE FROM chat_logs WHERE user_id=? AND agent_id=?').run(userId, agentId),

  /** 사용자의 세션 목록 (agent별 최신 대화 그룹) */
  sessions: (userId: string, limit = 50) =>
    db.prepare(`
      SELECT agent_id, session_key, MAX(created_at) as last_at, COUNT(*) as msg_count
      FROM chat_logs WHERE user_id=?
      GROUP BY agent_id, session_key
      ORDER BY last_at DESC LIMIT ?
    `).all(userId, limit) as ChatSession[],

  /** 특정 세션의 메시지 조회 */
  sessionMessages: (userId: string, agentId: string, sessionKey?: string, limit = 200) => {
    if (sessionKey) {
      return db.prepare('SELECT * FROM chat_logs WHERE user_id=? AND agent_id=? AND session_key=? ORDER BY created_at ASC LIMIT ?')
        .all(userId, agentId, sessionKey, limit) as ChatLog[];
    }
    return db.prepare('SELECT * FROM chat_logs WHERE user_id=? AND agent_id=? ORDER BY created_at ASC LIMIT ?')
      .all(userId, agentId, limit) as ChatLog[];
  },

  /** 에이전트별 필터 + 날짜 범위 세션 목록 */
  sessionsFiltered: (userId: string, opts: { agentId?: string; from?: number; to?: number; limit?: number }) => {
    const conditions: string[] = ['user_id=?'];
    const params: unknown[] = [userId];

    if (opts.agentId) { conditions.push('agent_id=?'); params.push(opts.agentId); }
    if (opts.from)    { conditions.push('created_at>=?'); params.push(opts.from); }
    if (opts.to)      { conditions.push('created_at<=?'); params.push(opts.to); }

    const where = conditions.join(' AND ');
    const limit = opts.limit ?? 50;
    params.push(limit);

    return db.prepare(`
      SELECT agent_id, session_key, MAX(created_at) as last_at, COUNT(*) as msg_count
      FROM chat_logs WHERE ${where}
      GROUP BY agent_id, session_key
      ORDER BY last_at DESC LIMIT ?
    `).all(...params) as ChatSession[];
  },

  /** FTS5 전문 검색 */
  search: (userId: string, query: string, limit = 50) => {
    return db.prepare(`
      SELECT cl.*
      FROM chat_logs_fts fts
      JOIN chat_logs cl ON cl.rowid = fts.rowid
      WHERE chat_logs_fts MATCH ? AND cl.user_id = ?
      ORDER BY fts.rank LIMIT ?
    `).all(query, userId, limit) as ChatLog[];
  },

  /** 세션 삭제 */
  deleteSession: (userId: string, agentId: string, sessionKey?: string) => {
    if (sessionKey) {
      return db.prepare('DELETE FROM chat_logs WHERE user_id=? AND agent_id=? AND session_key=?')
        .run(userId, agentId, sessionKey);
    }
    return db.prepare('DELETE FROM chat_logs WHERE user_id=? AND agent_id=? AND session_key IS NULL')
      .run(userId, agentId);
  },

  /** 세션 내보내기 (JSON) */
  exportSession: (userId: string, agentId: string, sessionKey?: string): { agentId: string; sessionKey: string | null; messages: ChatLog[] } => {
    const messages = sessionKey
      ? db.prepare('SELECT * FROM chat_logs WHERE user_id=? AND agent_id=? AND session_key=? ORDER BY created_at ASC')
          .all(userId, agentId, sessionKey) as ChatLog[]
      : db.prepare('SELECT * FROM chat_logs WHERE user_id=? AND agent_id=? AND session_key IS NULL ORDER BY created_at ASC')
          .all(userId, agentId) as ChatLog[];
    return { agentId, sessionKey: sessionKey ?? null, messages };
  },
};

export const Notifications = {
  list:        (userId: string) => db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC').all(userId) as Notification[],
  unreadCount: (userId: string) => (db.prepare('SELECT COUNT(*) as cnt FROM notifications WHERE user_id=? AND read=0').get(userId) as { cnt: number })?.cnt || 0,
  create:      (n: Omit<Notification, 'created_at'>) =>
    db.prepare('INSERT OR IGNORE INTO notifications(id,user_id,type,title,message) VALUES(?,?,?,?,?)').run(n.id, n.user_id, n.type, n.title, n.message),
  markRead:    (id: string) => db.prepare('UPDATE notifications SET read=1 WHERE id=?').run(id),
  markAllRead: (userId: string) => db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(userId),
  delete:      (id: string) => db.prepare('DELETE FROM notifications WHERE id=?').run(id),
};

export const Missions = {
  list:   (userId: string) => db.prepare('SELECT * FROM missions WHERE user_id=? ORDER BY created_at DESC').all(userId) as Mission[],
  get:    (id: string) => db.prepare('SELECT * FROM missions WHERE id=?').get(id) as Mission | undefined,
  create: (m: { id: string; user_id: string; task: string; routing: string; parent_mission_id?: string; origin?: string }) =>
    db.prepare('INSERT INTO missions(id,user_id,task,routing,parent_mission_id,origin) VALUES(?,?,?,?,?,?)')
      .run(m.id, m.user_id, m.task, m.routing, m.parent_mission_id ?? null, m.origin ?? 'user'),
  listByParent: (parentId: string) => db.prepare("SELECT * FROM missions WHERE parent_mission_id=? ORDER BY created_at ASC").all(parentId) as Mission[],
  update: (id: string, fields: Partial<Mission>) => {
    const sets = Object.keys(fields).map(k => `${k}=?`).join(',') + ',updated_at=unixepoch()';
    db.prepare(`UPDATE missions SET ${sets} WHERE id=?`).run(...Object.values(fields), id);
  },
  delete: (id: string) => {
    db.prepare('DELETE FROM mission_jobs WHERE mission_id=?').run(id);
    db.prepare('DELETE FROM missions WHERE id=?').run(id);
  },
};

export const MissionJobs = {
  create: (j: { id: string; mission_id: string; agent_id: string; agent_name: string; org_name: string; subtask: string; gate_type?: string }) =>
    db.prepare('INSERT INTO mission_jobs(id,mission_id,agent_id,agent_name,org_name,subtask,gate_type) VALUES(?,?,?,?,?,?,?)')
      .run(j.id, j.mission_id, j.agent_id, j.agent_name, j.org_name, j.subtask, j.gate_type ?? 'auto'),
  listByMission:   (missionId: string) => db.prepare('SELECT * FROM mission_jobs WHERE mission_id=? ORDER BY queued_at').all(missionId) as MissionJob[],
  queueForAgent:   (agentId: string) => db.prepare("SELECT * FROM mission_jobs WHERE agent_id=? AND status IN ('queued','running','gate_pending') ORDER BY queued_at").all(agentId) as MissionJob[],
  runningForAgent: (agentId: string) => db.prepare("SELECT * FROM mission_jobs WHERE agent_id=? AND status IN ('running','gate_pending')").get(agentId) as MissionJob | undefined,
  nextQueued:      (agentId: string) => db.prepare("SELECT * FROM mission_jobs WHERE agent_id=? AND status='queued' ORDER BY queued_at LIMIT 1").get(agentId) as MissionJob | undefined,
  start:           (id: string) => db.prepare("UPDATE mission_jobs SET status='running', started_at=unixepoch() WHERE id=?").run(id),
  finish:          (id: string, result: string) => db.prepare("UPDATE mission_jobs SET status='done', result=?, finished_at=unixepoch() WHERE id=?").run(result, id),
  fail:            (id: string, error: string) => db.prepare("UPDATE mission_jobs SET status='failed', error=?, finished_at=unixepoch() WHERE id=?").run(error, id),
  get:             (id: string) => db.prepare('SELECT * FROM mission_jobs WHERE id=?').get(id) as MissionJob | undefined,
  setPendingGate:    (id: string) => db.prepare("UPDATE mission_jobs SET status='gate_pending', gate_status='pending' WHERE id=?").run(id),
  approve:           (id: string) => db.prepare("UPDATE mission_jobs SET gate_status='approved' WHERE id=?").run(id),
  setQualityScores:  (id: string, scores: string) => db.prepare("UPDATE mission_jobs SET quality_scores=? WHERE id=?").run(scores, id),
};

export const MissionTemplates = {
  list:   (userId: string) => db.prepare('SELECT * FROM mission_templates WHERE user_id=? OR is_builtin=1 ORDER BY is_builtin DESC, created_at DESC').all(userId) as MissionTemplate[],
  get:    (id: string) => db.prepare('SELECT * FROM mission_templates WHERE id=?').get(id) as MissionTemplate | undefined,
  create: (t: { id: string; user_id: string; name: string; description: string; task: string; tags?: string; is_builtin?: number }) =>
    db.prepare('INSERT INTO mission_templates(id,user_id,name,description,task,tags,is_builtin) VALUES(?,?,?,?,?,?,?)').run(t.id, t.user_id, t.name, t.description, t.task, t.tags ?? '[]', t.is_builtin ?? 0),
  delete: (id: string) => db.prepare('DELETE FROM mission_templates WHERE id=?').run(id),
};

export const McpServerConfigs = {
  list:        (userId: string) => db.prepare('SELECT * FROM mcp_server_configs WHERE user_id=? ORDER BY created_at').all(userId) as McpServerConfig[],
  listEnabled: (userId: string) => db.prepare("SELECT * FROM mcp_server_configs WHERE user_id=? AND enabled=1 ORDER BY created_at").all(userId) as McpServerConfig[],
  get:         (id: string) => db.prepare('SELECT * FROM mcp_server_configs WHERE id=?').get(id) as McpServerConfig | undefined,
  create:      (c: { id: string; user_id: string; name: string; label: string; command: string; args?: string; env_json?: string }) =>
    db.prepare('INSERT INTO mcp_server_configs(id,user_id,name,label,command,args,env_json) VALUES(?,?,?,?,?,?,?)').run(c.id, c.user_id, c.name, c.label, c.command, c.args ?? '[]', c.env_json ?? '{}'),
  setEnabled:  (id: string, enabled: boolean) => db.prepare('UPDATE mcp_server_configs SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id),
  delete:      (id: string) => db.prepare('DELETE FROM mcp_server_configs WHERE id=?').run(id),
};

export const MissionSchedules = {
  list:    (userId: string) => db.prepare('SELECT * FROM mission_schedules WHERE user_id=? ORDER BY created_at DESC').all(userId) as MissionSchedule[],
  listDue: () => db.prepare('SELECT * FROM mission_schedules WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= unixepoch() AND openclaw_cron_id IS NULL').all() as MissionSchedule[],
  get:     (id: string) => db.prepare('SELECT * FROM mission_schedules WHERE id=?').get(id) as MissionSchedule | undefined,
  create:  (s: { id: string; user_id: string; name: string; cron_expr: string; task: string; routing: string; session_cookie?: string; next_run_at: number }) =>
    db.prepare('INSERT INTO mission_schedules(id,user_id,name,cron_expr,task,routing,session_cookie,next_run_at) VALUES(?,?,?,?,?,?,?,?)').run(s.id, s.user_id, s.name, s.cron_expr, s.task, s.routing, s.session_cookie ?? '', s.next_run_at),
  update:  (id: string, fields: Partial<MissionSchedule>) => {
    const sets = Object.keys(fields).map(k => `${k}=?`).join(',');
    db.prepare(`UPDATE mission_schedules SET ${sets} WHERE id=?`).run(...Object.values(fields), id);
  },
  delete:  (id: string) => db.prepare('DELETE FROM mission_schedules WHERE id=?').run(id),
  setEnabled: (id: string, enabled: boolean) => db.prepare('UPDATE mission_schedules SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id),
  tick:    (id: string, lastRunAt: number, nextRunAt: number) =>
    db.prepare('UPDATE mission_schedules SET last_run_at=?, next_run_at=? WHERE id=?').run(lastRunAt, nextRunAt, id),
};

// ── 인터페이스 ────────────────────────────────────────────────────────

export interface ChatLog {
  id: string; user_id: string; agent_id: string; role: string; content: string; session_key?: string; created_at?: number;
}
export interface ChatSession {
  agent_id: string; session_key: string | null; last_at: number; msg_count: number;
}
export interface Notification {
  id: string; user_id: string; type: string; title: string; message: string; read: number; created_at?: number;
}
export interface Mission {
  id: string; user_id: string; task: string; status: string;
  routing: string; steps: string; final_doc: string; images?: string;
  error?: string;
  parent_mission_id?: string; origin: string;
  created_at?: number; updated_at?: number;
}
export interface MissionJob {
  id: string; mission_id: string; agent_id: string; agent_name: string;
  org_name: string; subtask: string; status: string;
  gate_type: string; gate_status: string;
  quality_scores?: string;
  result: string; error: string;
  queued_at?: number; started_at?: number; finished_at?: number;
}
export interface MissionTemplate {
  id: string; user_id: string; name: string; description: string;
  task: string; tags: string; is_builtin: number; created_at?: number;
}
export interface McpServerConfig {
  id: string; user_id: string; name: string; label: string;
  command: string; args: string; env_json: string; enabled: number; created_at?: number;
}
export interface MissionSchedule {
  id: string; user_id: string; name: string; cron_expr: string;
  task: string; routing: string; session_cookie: string; enabled: number;
  last_run_at?: number; next_run_at?: number; created_at?: number;
}
