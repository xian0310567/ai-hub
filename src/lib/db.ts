import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'hub.db'));

db.exec(`
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
  -- org_level: division|department|team|part|worker
  -- org_id: 소속 계층 ID (division_id / workspace_id / team_id / part_id)
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
`);

// 마이그레이션: 기존 컬럼 없으면 추가
try { db.exec(`ALTER TABLE workspaces ADD COLUMN division_id TEXT REFERENCES divisions(id) ON DELETE SET NULL`); } catch {}
try { db.exec(`ALTER TABLE agents ADD COLUMN part_id TEXT REFERENCES parts(id) ON DELETE SET NULL`); } catch {}
try { db.exec(`ALTER TABLE agents ADD COLUMN org_level TEXT NOT NULL DEFAULT 'worker'`); } catch {}
try { db.exec('ALTER TABLE divisions ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE workspaces ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0'); } catch {}

export default db;

// ── 헬퍼 ─────────────────────────────────────────────────────────────

export const Settings = {
  get: (key: string) => (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as any)?.value,
  set: (key: string, value: string) => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, value),
};

export const Divisions = {
  listAll: () => db.prepare('SELECT * FROM divisions ORDER BY order_index, created_at').all() as Division[],
  get:     (id: string) => db.prepare('SELECT * FROM divisions WHERE id=?').get(id) as Division | undefined,
  create:  (d: Omit<Division,'created_at'>) => db.prepare('INSERT INTO divisions(id,name,color,ws_path) VALUES(?,?,?,?)').run(d.id,d.name,d.color,d.ws_path||''),
  delete:  (id: string) => db.prepare('DELETE FROM divisions WHERE id=?').run(id),
};

export const Workspaces = {
  list:         () => db.prepare('SELECT * FROM workspaces ORDER BY created_at DESC').all() as Workspace[],
  listByDiv:    (divId: string) => db.prepare('SELECT * FROM workspaces WHERE division_id=? ORDER BY order_index, created_at').all(divId) as Workspace[],
  listUnassigned: () => db.prepare('SELECT * FROM workspaces WHERE division_id IS NULL ORDER BY order_index, created_at').all() as Workspace[],
  get:          (id: string) => db.prepare('SELECT * FROM workspaces WHERE id=?').get(id) as Workspace | undefined,
  create:       (ws: Omit<Workspace,'created_at'>) => db.prepare('INSERT INTO workspaces(id,name,path,division_id) VALUES(?,?,?,?)').run(ws.id,ws.name,ws.path,ws.division_id??null),
  delete:       (id: string) => db.prepare('DELETE FROM workspaces WHERE id=?').run(id),
};

export const Teams = {
  list:    (workspaceId: string) => db.prepare('SELECT * FROM teams WHERE workspace_id=? ORDER BY created_at').all(workspaceId) as Team[],
  listAll: () => db.prepare('SELECT * FROM teams ORDER BY created_at').all() as Team[],
  get:     (id: string) => db.prepare('SELECT * FROM teams WHERE id=?').get(id) as Team | undefined,
  create:  (t: Omit<Team,'created_at'>) => db.prepare('INSERT INTO teams(id,name,description,color,workspace_id) VALUES(?,?,?,?,?)').run(t.id,t.name,t.description,t.color,t.workspace_id),
  delete:  (id: string) => db.prepare('DELETE FROM teams WHERE id=?').run(id),
};

export const Parts = {
  list:    (teamId: string) => db.prepare('SELECT * FROM parts WHERE team_id=? ORDER BY created_at').all(teamId) as Part[],
  listAll: () => db.prepare('SELECT * FROM parts ORDER BY created_at').all() as Part[],
  get:     (id: string) => db.prepare('SELECT * FROM parts WHERE id=?').get(id) as Part | undefined,
  create:  (p: Omit<Part,'created_at'>) => db.prepare('INSERT INTO parts(id,name,color,team_id) VALUES(?,?,?,?)').run(p.id,p.name,p.color,p.team_id),
  delete:  (id: string) => db.prepare('DELETE FROM parts WHERE id=?').run(id),
};

export const Agents = {
  list:        (workspaceId: string) => db.prepare('SELECT * FROM agents WHERE workspace_id=? ORDER BY created_at').all(workspaceId) as Agent[],
  listAll:     () => db.prepare('SELECT * FROM agents ORDER BY created_at').all() as Agent[],
  listByTeam:  (teamId: string) => db.prepare('SELECT * FROM agents WHERE team_id=? AND part_id IS NULL ORDER BY is_lead DESC, created_at').all(teamId) as Agent[],
  listByPart:  (partId: string) => db.prepare('SELECT * FROM agents WHERE part_id=? ORDER BY is_lead DESC, created_at').all(partId) as Agent[],
  listSubs:    (parentId: string) => db.prepare('SELECT * FROM agents WHERE parent_agent_id=? ORDER BY created_at').all(parentId) as Agent[],
  get:         (id: string) => db.prepare('SELECT * FROM agents WHERE id=?').get(id) as Agent | undefined,
  create:      (a: Omit<Agent,'created_at'>) => db.prepare(
    'INSERT INTO agents(id,workspace_id,team_id,part_id,parent_agent_id,org_level,is_lead,name,emoji,color,soul,command_name,harness_pattern) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(a.id,a.workspace_id,a.team_id??null,a.part_id??null,a.parent_agent_id??null,a.org_level??'worker',a.is_lead?1:0,a.name,a.emoji,a.color,a.soul,a.command_name??null,a.harness_pattern??'orchestrator'),
  update:      (id: string, fields: Partial<Agent>) => {
    const sets = Object.keys(fields).map(k=>`${k}=?`).join(',');
    db.prepare(`UPDATE agents SET ${sets} WHERE id=?`).run(...Object.values(fields),id);
  },
  delete:      (id: string) => db.prepare('DELETE FROM agents WHERE id=?').run(id),
};

// ── 인터페이스 ────────────────────────────────────────────────────────

export interface Division {
  id: string; name: string; color: string; ws_path: string; created_at?: number;
}
export interface Workspace {
  id: string; name: string; path: string; division_id?: string|null; created_at?: number;
}
export interface Team {
  id: string; name: string; description: string; color: string; workspace_id: string; created_at?: number;
}
export interface Part {
  id: string; name: string; color: string; team_id: string; created_at?: number;
}
export interface Agent {
  id: string; workspace_id: string; team_id: string|null; part_id: string|null;
  parent_agent_id: string|null; org_level: string; is_lead: number;
  name: string; emoji: string; color: string; soul: string;
  command_name: string|null; harness_pattern: string; created_at?: number;
}
