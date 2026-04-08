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

const db = new Database(path.join(DATA_DIR, 'local.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- 개인 대화 기록 (agent_id는 vm-server의 agents.id를 참조)
  CREATE TABLE IF NOT EXISTS chat_logs (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    agent_id   TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
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
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    task        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    routing     TEXT NOT NULL DEFAULT '[]',
    steps       TEXT NOT NULL DEFAULT '[]',
    final_doc   TEXT NOT NULL DEFAULT '',
    images      TEXT NOT NULL DEFAULT '[]',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- 미션 잡 큐 (에이전트별 순차 실행)
  CREATE TABLE IF NOT EXISTS mission_jobs (
    id          TEXT PRIMARY KEY,
    mission_id  TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    agent_id    TEXT NOT NULL,
    agent_name  TEXT NOT NULL,
    org_name    TEXT NOT NULL DEFAULT '',
    subtask     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'queued',
    result      TEXT NOT NULL DEFAULT '',
    error       TEXT NOT NULL DEFAULT '',
    queued_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    started_at  INTEGER,
    finished_at INTEGER
  );
`);

// 서버 재시작 시 stuck 잡 정리
db.prepare("UPDATE missions SET status='failed' WHERE status IN ('analyzing','running')").run();
db.prepare("UPDATE mission_jobs SET status='failed' WHERE status='running'").run();

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
    db.prepare('INSERT INTO chat_logs(id,user_id,agent_id,role,content) VALUES(?,?,?,?,?)').run(log.id, log.user_id, log.agent_id, log.role, log.content),
  clear: (userId: string, agentId: string) =>
    db.prepare('DELETE FROM chat_logs WHERE user_id=? AND agent_id=?').run(userId, agentId),
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
  create: (m: { id: string; user_id: string; task: string; routing: string }) =>
    db.prepare('INSERT INTO missions(id,user_id,task,routing) VALUES(?,?,?,?)').run(m.id, m.user_id, m.task, m.routing),
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
  create: (j: { id: string; mission_id: string; agent_id: string; agent_name: string; org_name: string; subtask: string }) =>
    db.prepare('INSERT INTO mission_jobs(id,mission_id,agent_id,agent_name,org_name,subtask) VALUES(?,?,?,?,?,?)').run(j.id, j.mission_id, j.agent_id, j.agent_name, j.org_name, j.subtask),
  listByMission:   (missionId: string) => db.prepare('SELECT * FROM mission_jobs WHERE mission_id=? ORDER BY queued_at').all(missionId) as MissionJob[],
  queueForAgent:   (agentId: string) => db.prepare("SELECT * FROM mission_jobs WHERE agent_id=? AND status IN ('queued','running') ORDER BY queued_at").all(agentId) as MissionJob[],
  runningForAgent: (agentId: string) => db.prepare("SELECT * FROM mission_jobs WHERE agent_id=? AND status='running'").get(agentId) as MissionJob | undefined,
  nextQueued:      (agentId: string) => db.prepare("SELECT * FROM mission_jobs WHERE agent_id=? AND status='queued' ORDER BY queued_at LIMIT 1").get(agentId) as MissionJob | undefined,
  start:           (id: string) => db.prepare("UPDATE mission_jobs SET status='running', started_at=unixepoch() WHERE id=?").run(id),
  finish:          (id: string, result: string) => db.prepare("UPDATE mission_jobs SET status='done', result=?, finished_at=unixepoch() WHERE id=?").run(result, id),
  fail:            (id: string, error: string) => db.prepare("UPDATE mission_jobs SET status='failed', error=?, finished_at=unixepoch() WHERE id=?").run(error, id),
  get:             (id: string) => db.prepare('SELECT * FROM mission_jobs WHERE id=?').get(id) as MissionJob | undefined,
};

// ── 인터페이스 ────────────────────────────────────────────────────────

export interface ChatLog {
  id: string; user_id: string; agent_id: string; role: string; content: string; created_at?: number;
}
export interface Notification {
  id: string; user_id: string; type: string; title: string; message: string; read: number; created_at?: number;
}
export interface Mission {
  id: string; user_id: string; task: string; status: string;
  routing: string; steps: string; final_doc: string; images?: string;
  created_at?: number; updated_at?: number;
}
export interface MissionJob {
  id: string; mission_id: string; agent_id: string; agent_name: string;
  org_name: string; subtask: string; status: string;
  result: string; error: string;
  queued_at?: number; started_at?: number; finished_at?: number;
}
