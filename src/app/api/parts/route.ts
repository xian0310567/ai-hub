import { NextRequest } from 'next/server';
import { Parts, Teams } from '@/lib/db';
import { getSession } from '@/lib/auth';
import { randomUUID } from 'crypto';
import db from '@/lib/db';

// GET /api/parts?team_id=xxx
export async function GET(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const teamId = req.nextUrl.searchParams.get('team_id');
  const parts  = teamId ? Parts.list(teamId) : Parts.listByUser(user.id);
  return Response.json({ ok: true, parts });
}

// POST /api/parts
export async function POST(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { team_id, name, color = '#0891b2' } = await req.json() as {
    team_id: string; name: string; color?: string;
  };
  if (!team_id || !name?.trim()) return Response.json({ ok: false, error: '팀 ID와 파트명 필수' }, { status: 400 });

  const team = Teams.get(team_id);
  if (!team || team.user_id !== user.id) return Response.json({ ok: false, error: '팀 없음' }, { status: 404 });

  const id = randomUUID();
  Parts.create({ id, name, color, team_id, user_id: user.id });
  return Response.json({ ok: true, part: Parts.get(id) });
}

// DELETE /api/parts?id=xxx
export async function DELETE(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });

  const part = Parts.get(id);
  if (!part || part.user_id !== user.id) return Response.json({ ok: false, error: '없음' }, { status: 404 });

  Parts.delete(id);
  return Response.json({ ok: true });
}

// PATCH /api/parts — 파트 수정 (이름/색상 또는 team_id 이동)
export async function PATCH(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { id, name, color, team_id } = await req.json();
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });

  const part = Parts.get(id);
  if (!part || part.user_id !== user.id) return Response.json({ ok: false, error: '없음' }, { status: 404 });

  if (team_id) {
    // 이동 — 대상 팀 소유권 확인
    const team = Teams.get(team_id);
    if (!team || team.user_id !== user.id) return Response.json({ ok: false, error: '팀을 찾을 수 없습니다' }, { status: 404 });
    db.prepare('UPDATE parts SET team_id=? WHERE id=?').run(team_id, id);
  }
  if (name) db.prepare('UPDATE parts SET name=? WHERE id=?').run(name, id);
  if (color) db.prepare('UPDATE parts SET color=? WHERE id=?').run(color, id);
  return Response.json({ ok: true, part: Parts.get(id) });
}
