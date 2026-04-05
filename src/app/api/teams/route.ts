import { NextRequest } from 'next/server';
import { Teams, Agents, Workspaces } from '@/lib/db';
import db from '@/lib/db';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';

const WS_BASE = process.env.WORKSPACES_DIR || path.join(process.cwd(), '.data', 'workspaces');

// GET /api/teams — 전체 조직도
export async function GET() {
  const teams = Teams.listAll();
  const result = teams.map(team => ({
    ...team,
    agents: Agents.listByTeam(team.id).map(agent => ({
      ...agent,
      subAgents: Agents.listSubs(agent.id),
    })),
  }));
  return Response.json({ ok: true, teams: result });
}

// POST /api/teams — 팀 생성 (워크스페이스 자동 생성)
export async function POST(req: NextRequest) {
  const { name, description = '', color = '#6b7280' } = await req.json() as {
    name: string; description?: string; color?: string;
  };
  if (!name?.trim()) return Response.json({ ok: false, error: '팀 이름을 입력하세요' }, { status: 400 });

  // 워크스페이스 자동 생성
  const wsId   = randomUUID();
  const slug   = name.toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-').replace(/^-|-$/, '');
  const wsPath = path.join(WS_BASE, `${slug}-${wsId.slice(0,6)}`);

  for (const d of [
    wsPath,
    path.join(wsPath, 'memory'),
    path.join(wsPath, '.claude', 'agents'),
    path.join(wsPath, '.claude', 'commands'),
    path.join(wsPath, '.claude', 'skills'),
  ]) fs.mkdirSync(d, { recursive: true });

  Workspaces.create({ id: wsId, name: `${name} workspace`, path: wsPath });

  // 팀 생성
  const teamId = randomUUID();
  Teams.create({ id: teamId, name, description, color, workspace_id: wsId });

  return Response.json({ ok: true, team: { ...Teams.get(teamId), workspace: Workspaces.get(wsId) } });
}

// DELETE /api/teams?id=xxx
export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return Response.json({ ok:false, error:'id required' }, { status:400 });
  Teams.delete(id);
  return Response.json({ ok: true });
}

// PATCH /api/teams — 팀 수정
export async function PATCH(req: Request) {
  const { id, name, description, color } = await req.json();
  if (!id) return Response.json({ ok:false, error:'id required' }, { status:400 });
  const team = Teams.get(id);
  if (!team) return Response.json({ ok:false, error:'팀 없음' }, { status:404 });
  if (name) db.prepare('UPDATE teams SET name=? WHERE id=?').run(name, id);
  if (description !== undefined) db.prepare('UPDATE teams SET description=? WHERE id=?').run(description, id);
  if (color) db.prepare('UPDATE teams SET color=? WHERE id=?').run(color, id);
  return Response.json({ ok: true, team: Teams.get(id) });
}
