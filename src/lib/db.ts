import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'hub.db'));
db.pragma('foreign_keys = OFF'); // division 에이전트가 division.id를 workspace_id로 사용하므로

db.exec(`
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

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- 부문 (Division): 최상위 조직
  CREATE TABLE IF NOT EXISTS divisions (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#6b7280',
    ws_path    TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- 실 (Department): 부문 하위, 워크스페이스 단위
  CREATE TABLE IF NOT EXISTS workspaces (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL,
    division_id TEXT REFERENCES divisions(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- 팀 (Team): 실 하위
  CREATE TABLE IF NOT EXISTS teams (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT '#6b7280',
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- 파트 (Part): 팀 하위
  CREATE TABLE IF NOT EXISTS parts (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#6b7280',
    team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- 에이전트: 각 계층의 장(lead) 또는 실무자
  CREATE TABLE IF NOT EXISTS agents (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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
    harness_pattern TEXT DEFAULT 'orchestrator',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS chat_logs (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    agent_id   TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    agent_id    TEXT,
    agent_name  TEXT,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'pending',
    result      TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS missions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    task        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    routing     TEXT NOT NULL DEFAULT '[]',
    steps       TEXT NOT NULL DEFAULT '[]',
    final_doc   TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS mission_jobs (
    id          TEXT PRIMARY KEY,
    mission_id  TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    agent_name  TEXT NOT NULL,
    org_name    TEXT NOT NULL,
    subtask     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'queued',
    result      TEXT NOT NULL DEFAULT '',
    error       TEXT NOT NULL DEFAULT '',
    queued_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    started_at  INTEGER,
    finished_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'info',
    title      TEXT NOT NULL,
    message    TEXT NOT NULL,
    read       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

// 마이그레이션: 기존 컬럼 없으면 추가
try { db.exec(`ALTER TABLE workspaces ADD COLUMN division_id TEXT REFERENCES divisions(id) ON DELETE SET NULL`); } catch {}
try { db.exec(`ALTER TABLE agents ADD COLUMN part_id TEXT REFERENCES parts(id) ON DELETE SET NULL`); } catch {}
try { db.exec(`ALTER TABLE agents ADD COLUMN org_level TEXT NOT NULL DEFAULT 'worker'`); } catch {}
try { db.exec('ALTER TABLE divisions ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE workspaces ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0'); } catch {}
// 멀티유저 마이그레이션
try { db.exec(`ALTER TABLE divisions ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE workspaces ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE teams ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE parts ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE agents ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE agents ADD COLUMN model TEXT NOT NULL DEFAULT 'claude-sonnet-4-5'`); } catch {}
// OAuth 토큰 저장
try { db.exec(`ALTER TABLE users ADD COLUMN oauth_token TEXT`); } catch {}
try { db.exec('ALTER TABLE teams ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE parts ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec(`ALTER TABLE divisions ADD COLUMN harness_prompt TEXT NOT NULL DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE workspaces ADD COLUMN harness_prompt TEXT NOT NULL DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE teams ADD COLUMN harness_prompt TEXT NOT NULL DEFAULT ''`); } catch {}

export default db;

// ── 헬퍼 ─────────────────────────────────────────────────────────────

export const Settings = {
  get: (key: string) => (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as any)?.value,
  set: (key: string, value: string) => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, value),
};

export const Users = {
  get:           (id: string) => db.prepare('SELECT * FROM users WHERE id=?').get(id) as User | undefined,
  getByUsername: (username: string) => db.prepare('SELECT * FROM users WHERE username=?').get(username) as User | undefined,
  create:        (u: { id: string; username: string; password_hash: string }) =>
    db.prepare('INSERT INTO users(id,username,password_hash) VALUES(?,?,?)').run(u.id, u.username, u.password_hash),
  setOauthToken: (id: string, token: string) =>
    db.prepare('UPDATE users SET oauth_token=? WHERE id=?').run(token, id),
};

export const Sessions = {
  get:    (id: string, now: number) =>
    db.prepare('SELECT s.*, u.id as uid, u.username FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.id=? AND s.expires_at>?').get(id, now) as (Session & { uid: string; username: string }) | undefined,
  create: (s: { id: string; user_id: string; expires_at: number }) =>
    db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(s.id, s.user_id, s.expires_at),
  delete: (id: string) => db.prepare('DELETE FROM sessions WHERE id=?').run(id),
};

export const Divisions = {
  list:   (userId: string) => db.prepare('SELECT * FROM divisions WHERE user_id=? ORDER BY order_index, created_at').all(userId) as Division[],
  get:    (id: string) => db.prepare('SELECT * FROM divisions WHERE id=?').get(id) as Division | undefined,
  create: (d: Omit<Division,'created_at'> & { user_id: string }) =>
    db.prepare('INSERT INTO divisions(id,name,color,ws_path,user_id) VALUES(?,?,?,?,?)').run(d.id,d.name,d.color,d.ws_path||'',d.user_id),
  delete: (id: string) => db.prepare('DELETE FROM divisions WHERE id=?').run(id),
};

export const Workspaces = {
  listByUser:     (userId: string) => db.prepare('SELECT * FROM workspaces WHERE user_id=? ORDER BY created_at DESC').all(userId) as Workspace[],
  listByDiv:      (divId: string) => db.prepare('SELECT * FROM workspaces WHERE division_id=? ORDER BY order_index, created_at').all(divId) as Workspace[],
  listUnassigned: (userId: string) => db.prepare('SELECT * FROM workspaces WHERE user_id=? AND division_id IS NULL ORDER BY order_index, created_at').all(userId) as Workspace[],
  get:            (id: string) => db.prepare('SELECT * FROM workspaces WHERE id=?').get(id) as Workspace | undefined,
  create:         (ws: Omit<Workspace,'created_at'> & { user_id: string }) =>
    db.prepare('INSERT INTO workspaces(id,name,path,division_id,user_id) VALUES(?,?,?,?,?)').run(ws.id,ws.name,ws.path,ws.division_id??null,ws.user_id),
  delete:         (id: string) => db.prepare('DELETE FROM workspaces WHERE id=?').run(id),
};

export const Teams = {
  list:       (workspaceId: string) => db.prepare('SELECT * FROM teams WHERE workspace_id=? ORDER BY order_index, created_at').all(workspaceId) as Team[],
  listByUser: (userId: string) => db.prepare('SELECT * FROM teams WHERE user_id=? ORDER BY order_index, created_at').all(userId) as Team[],
  get:        (id: string) => db.prepare('SELECT * FROM teams WHERE id=?').get(id) as Team | undefined,
  create:     (t: Omit<Team,'created_at'> & { user_id: string }) =>
    db.prepare('INSERT INTO teams(id,name,description,color,workspace_id,user_id) VALUES(?,?,?,?,?,?)').run(t.id,t.name,t.description,t.color,t.workspace_id,t.user_id),
  delete:     (id: string) => db.prepare('DELETE FROM teams WHERE id=?').run(id),
};

export const Parts = {
  list:       (teamId: string) => db.prepare('SELECT * FROM parts WHERE team_id=? ORDER BY order_index, created_at').all(teamId) as Part[],
  listByUser: (userId: string) => db.prepare('SELECT * FROM parts WHERE user_id=? ORDER BY order_index, created_at').all(userId) as Part[],
  get:        (id: string) => db.prepare('SELECT * FROM parts WHERE id=?').get(id) as Part | undefined,
  create:     (p: Omit<Part,'created_at'> & { user_id: string }) =>
    db.prepare('INSERT INTO parts(id,name,color,team_id,user_id) VALUES(?,?,?,?,?)').run(p.id,p.name,p.color,p.team_id,p.user_id),
  delete:     (id: string) => db.prepare('DELETE FROM parts WHERE id=?').run(id),
};

export const Agents = {
  list:        (workspaceId: string) => db.prepare('SELECT * FROM agents WHERE workspace_id=? ORDER BY created_at').all(workspaceId) as Agent[],
  listByUser:  (userId: string) => db.prepare('SELECT * FROM agents WHERE user_id=? ORDER BY created_at').all(userId) as Agent[],
  listByTeam:  (teamId: string) => db.prepare('SELECT * FROM agents WHERE team_id=? AND part_id IS NULL ORDER BY is_lead DESC, created_at').all(teamId) as Agent[],
  listByPart:  (partId: string) => db.prepare('SELECT * FROM agents WHERE part_id=? ORDER BY is_lead DESC, created_at').all(partId) as Agent[],
  listSubs:    (parentId: string) => db.prepare('SELECT * FROM agents WHERE parent_agent_id=? ORDER BY created_at').all(parentId) as Agent[],
  get:         (id: string) => db.prepare('SELECT * FROM agents WHERE id=?').get(id) as Agent | undefined,
  create:      (a: Omit<Agent,'created_at'> & { user_id: string }) => db.prepare(
    'INSERT INTO agents(id,workspace_id,team_id,part_id,parent_agent_id,org_level,is_lead,name,emoji,color,soul,command_name,harness_pattern,user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(a.id,a.workspace_id,a.team_id??null,a.part_id??null,a.parent_agent_id??null,a.org_level??'worker',a.is_lead?1:0,a.name,a.emoji,a.color,a.soul,a.command_name??null,a.harness_pattern??'orchestrator',a.user_id),
  update:      (id: string, fields: Partial<Agent>) => {
    const sets = Object.keys(fields).map(k=>`${k}=?`).join(',');
    db.prepare(`UPDATE agents SET ${sets} WHERE id=?`).run(...Object.values(fields),id);
  },
  delete:      (id: string) => db.prepare('DELETE FROM agents WHERE id=?').run(id),
};

export const ChatLogs = {
  list:   (userId: string, agentId: string, limit = 100) =>
    db.prepare('SELECT * FROM chat_logs WHERE user_id=? AND agent_id=? ORDER BY created_at DESC LIMIT ?').all(userId, agentId, limit).reverse() as ChatLog[],
  add:    (log: Omit<ChatLog, 'created_at'>) =>
    db.prepare('INSERT INTO chat_logs(id,user_id,agent_id,role,content) VALUES(?,?,?,?,?)').run(log.id, log.user_id, log.agent_id, log.role, log.content),
  clear:  (userId: string, agentId: string) =>
    db.prepare('DELETE FROM chat_logs WHERE user_id=? AND agent_id=?').run(userId, agentId),
};

export const Tasks = {
  list:   (userId: string) =>
    db.prepare('SELECT * FROM tasks WHERE user_id=? ORDER BY created_at DESC').all(userId) as Task[],
  get:    (id: string) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Task | undefined,
  create: (t: Omit<Task,'created_at'|'updated_at'>) =>
    db.prepare('INSERT INTO tasks(id,user_id,agent_id,agent_name,title,description,status,result) VALUES(?,?,?,?,?,?,?,?)').run(t.id,t.user_id,t.agent_id??null,t.agent_name??null,t.title,t.description,t.status??'pending',t.result??''),
  update: (id: string, fields: Partial<Task>) => {
    const sets = Object.keys(fields).map(k=>`${k}=?`).join(',') + ',updated_at=unixepoch()';
    db.prepare(`UPDATE tasks SET ${sets} WHERE id=?`).run(...Object.values(fields), id);
  },
  delete: (id: string) => db.prepare('DELETE FROM tasks WHERE id=?').run(id),
};

export const Missions = {
  list:   (userId: string) =>
    db.prepare('SELECT * FROM missions WHERE user_id=? ORDER BY created_at DESC').all(userId) as Mission[],
  get:    (id: string) => db.prepare('SELECT * FROM missions WHERE id=?').get(id) as Mission | undefined,
  create: (m: { id: string; user_id: string; task: string; routing: string }) =>
    db.prepare('INSERT INTO missions(id,user_id,task,routing) VALUES(?,?,?,?)').run(m.id, m.user_id, m.task, m.routing),
  update: (id: string, fields: Partial<Mission>) => {
    const sets = Object.keys(fields).map(k=>`${k}=?`).join(',') + ',updated_at=unixepoch()';
    db.prepare(`UPDATE missions SET ${sets} WHERE id=?`).run(...Object.values(fields), id);
  },
  delete: (id: string) => {
    db.prepare('DELETE FROM mission_jobs WHERE mission_id=?').run(id);
    db.prepare('DELETE FROM missions WHERE id=?').run(id);
  },
};

export const MissionJobs = {
  // 잡 생성
  create: (j: { id: string; mission_id: string; agent_id: string; agent_name: string; org_name: string; subtask: string }) =>
    db.prepare('INSERT INTO mission_jobs(id,mission_id,agent_id,agent_name,org_name,subtask) VALUES(?,?,?,?,?,?)')
      .run(j.id, j.mission_id, j.agent_id, j.agent_name, j.org_name, j.subtask),
  // 특정 미션의 잡 목록
  listByMission: (missionId: string) =>
    db.prepare('SELECT * FROM mission_jobs WHERE mission_id=? ORDER BY queued_at').all(missionId) as MissionJob[],
  // 특정 에이전트의 대기/실행 중 잡 (큐)
  queueForAgent: (agentId: string) =>
    db.prepare("SELECT * FROM mission_jobs WHERE agent_id=? AND status IN ('queued','running') ORDER BY queued_at").all(agentId) as MissionJob[],
  // 에이전트가 현재 실행 중인 잡
  runningForAgent: (agentId: string) =>
    db.prepare("SELECT * FROM mission_jobs WHERE agent_id=? AND status='running'").get(agentId) as MissionJob | undefined,
  // 다음 대기 잡 가져오기
  nextQueued: (agentId: string) =>
    db.prepare("SELECT * FROM mission_jobs WHERE agent_id=? AND status='queued' ORDER BY queued_at LIMIT 1").get(agentId) as MissionJob | undefined,
  // 상태 업데이트
  start: (id: string) =>
    db.prepare("UPDATE mission_jobs SET status='running', started_at=unixepoch() WHERE id=?").run(id),
  finish: (id: string, result: string) =>
    db.prepare("UPDATE mission_jobs SET status='done', result=?, finished_at=unixepoch() WHERE id=?").run(result, id),
  fail: (id: string, error: string) =>
    db.prepare("UPDATE mission_jobs SET status='failed', error=?, finished_at=unixepoch() WHERE id=?").run(error, id),
  get: (id: string) => db.prepare('SELECT * FROM mission_jobs WHERE id=?').get(id) as MissionJob | undefined,
  // 전체 대기 큐 (모든 에이전트)
  allPending: () =>
    db.prepare("SELECT * FROM mission_jobs WHERE status='queued' ORDER BY queued_at").all() as MissionJob[],
};

export const Notifications = {
  list:       (userId: string) => db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC').all(userId) as Notification[],
  unreadCount:(userId: string) => (db.prepare('SELECT COUNT(*) as cnt FROM notifications WHERE user_id=? AND read=0').get(userId) as any)?.cnt || 0,
  create:     (n: Omit<Notification,'created_at'>) => db.prepare('INSERT OR IGNORE INTO notifications(id,user_id,type,title,message) VALUES(?,?,?,?,?)').run(n.id,n.user_id,n.type,n.title,n.message),
  markRead:   (id: string) => db.prepare('UPDATE notifications SET read=1 WHERE id=?').run(id),
  markAllRead:(userId: string) => db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(userId),
  delete:     (id: string) => db.prepare('DELETE FROM notifications WHERE id=?').run(id),
};

// ── 인터페이스 ────────────────────────────────────────────────────────

export interface User {
  id: string; username: string; password_hash: string; oauth_token?: string | null; created_at?: number;
}
export interface Session {
  id: string; user_id: string; expires_at: number; created_at?: number;
}
export interface Division {
  id: string; name: string; color: string; ws_path: string; harness_prompt?: string; user_id?: string; created_at?: number;
}
export interface Workspace {
  id: string; name: string; path: string; division_id?: string|null; harness_prompt?: string; user_id?: string; created_at?: number;
}
export interface Team {
  id: string; name: string; description: string; color: string; workspace_id: string; harness_prompt?: string; order_index?: number; user_id?: string; created_at?: number;
}
export interface Part {
  id: string; name: string; color: string; team_id: string; user_id?: string; created_at?: number;
}
export interface ChatLog {
  id: string; user_id: string; agent_id: string; role: string; content: string; created_at?: number;
}
export interface Task {
  id: string; user_id: string; agent_id?: string|null; agent_name?: string|null;
  title: string; description: string; status: string; result: string;
  created_at?: number; updated_at?: number;
}
export interface Mission {
  id: string; user_id: string; task: string; status: string;
  routing: string; steps: string; final_doc: string;
  created_at?: number; updated_at?: number;
}
export interface MissionJob {
  id: string; mission_id: string; agent_id: string; agent_name: string;
  org_name: string; subtask: string; status: string;
  result: string; error: string;
  queued_at?: number; started_at?: number; finished_at?: number;
}
export interface Notification {
  id: string; user_id: string; type: string; title: string; message: string; read: number; created_at?: number;
}
export interface Agent {
  id: string; workspace_id: string; team_id: string|null; part_id: string|null;
  parent_agent_id: string|null; org_level: string; is_lead: number;
  name: string; emoji: string; color: string; soul: string;
  command_name: string|null; harness_pattern: string; model?: string; user_id?: string; created_at?: number;
}
