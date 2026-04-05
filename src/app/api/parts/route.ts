import { NextRequest } from 'next/server';
import { Parts, Teams, Workspaces, Agents } from '@/lib/db';
import { randomUUID } from 'crypto';

// GET /api/parts?team_id=xxx
export async function GET(req: NextRequest) {
  const teamId = req.nextUrl.searchParams.get('team_id');
  const parts  = teamId ? Parts.list(teamId) : Parts.listAll();
  return Response.json({ ok: true, parts });
}

// POST /api/parts
export async function POST(req: NextRequest) {
  const { team_id, name, color = '#0891b2' } = await req.json() as {
    team_id: string; name: string; color?: string;
  };
  if (!team_id || !name?.trim()) return Response.json({ ok: false, error: '팀 ID와 파트명 필수' }, { status: 400 });
  const team = Teams.get(team_id);
  if (!team) return Response.json({ ok: false, error: '팀 없음' }, { status: 404 });

  const id = randomUUID();
  Parts.create({ id, name, color, team_id });
  return Response.json({ ok: true, part: Parts.get(id) });
}

// DELETE /api/parts?id=xxx
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });
  Parts.delete(id);
  return Response.json({ ok: true });
}
