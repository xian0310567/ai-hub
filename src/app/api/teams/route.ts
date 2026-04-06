import { NextRequest } from 'next/server';
import { Teams, Agents, Workspaces } from '@/lib/db';
import { getSession, getUserWorkspacesDir } from '@/lib/auth';
import db from '@/lib/db';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';

// GET /api/teams — 전체 조직도
export async function GET(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const teams = Teams.listByUser(user.id);
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
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { name, description = '', color = '#6b7280', workspace_id } = await req.json() as {
    name: string; description?: string; color?: string; workspace_id?: string;
  };
  if (!name?.trim()) return Response.json({ ok: false, error: '팀 이름을 입력하세요' }, { status: 400 });

  let wsId: string;
  if (workspace_id) {
    // 기존 실(workspace)에 팀 추가 — 소유권 확인
    const ws = Workspaces.get(workspace_id);
    if (!ws || ws.user_id !== user.id) return Response.json({ ok: false, error: '워크스페이스를 찾을 수 없습니다' }, { status: 404 });
    wsId = workspace_id;
  } else {
    // workspace_id 없으면 새 워크스페이스 생성
    const WS_BASE = getUserWorkspacesDir(user.id);
    wsId = randomUUID();
    const slug   = name.toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-').replace(/^-|-$/, '');
    const wsPath = path.join(WS_BASE, `${slug}-${wsId.slice(0,6)}`);
    for (const d of [
      wsPath,
      path.join(wsPath, 'memory'),
      path.join(wsPath, '.claude', 'agents'),
      path.join(wsPath, '.claude', 'commands'),
      path.join(wsPath, '.claude', 'skills'),
    ]) fs.mkdirSync(d, { recursive: true });
    Workspaces.create({ id: wsId, name: `${name} workspace`, path: wsPath, user_id: user.id });
  }

  const teamId = randomUUID();
  Teams.create({ id: teamId, name, description, color, workspace_id: wsId, user_id: user.id });

  return Response.json({ ok: true, team: { ...Teams.get(teamId), workspace: Workspaces.get(wsId) } });
}

// DELETE /api/teams?id=xxx
export async function DELETE(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });

  const team = Teams.get(id);
  if (!team || team.user_id !== user.id) return Response.json({ ok: false, error: '없음' }, { status: 404 });

  Teams.delete(id);
  return Response.json({ ok: true });
}

// PATCH /api/teams — 팀 수정 (이름/색상/설명 또는 workspace_id 이동)
export async function PATCH(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { id, name, description, color, workspace_id } = await req.json();
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });

  const team = Teams.get(id);
  if (!team || team.user_id !== user.id) return Response.json({ ok: false, error: '없음' }, { status: 404 });

  if (workspace_id) {
    // 이동 — 대상 워크스페이스 소유권 확인
    const ws = Workspaces.get(workspace_id);
    if (!ws || ws.user_id !== user.id) return Response.json({ ok: false, error: '워크스페이스를 찾을 수 없습니다' }, { status: 404 });
    db.prepare('UPDATE teams SET workspace_id=? WHERE id=?').run(workspace_id, id);
  }
  if (name) db.prepare('UPDATE teams SET name=? WHERE id=?').run(name, id);
  if (description !== undefined) db.prepare('UPDATE teams SET description=? WHERE id=?').run(description, id);
  if (color) db.prepare('UPDATE teams SET color=? WHERE id=?').run(color, id);
  return Response.json({ ok: true, team: Teams.get(id) });
}
