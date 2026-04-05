import { NextRequest } from 'next/server';
import { Workspaces, Agents } from '@/lib/db';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';

const WS_BASE = process.env.WORKSPACES_DIR || path.join(process.cwd(), '.data', 'workspaces');

// GET /api/workspaces — 목록
export async function GET() {
  const workspaces = Workspaces.list();
  const result = workspaces.map(ws => ({
    ...ws,
    agents: Agents.list(ws.id),
  }));
  return Response.json({ ok: true, workspaces: result });
}

// POST /api/workspaces — 생성
export async function POST(req: NextRequest) {
  const { name, division_id } = await req.json() as { name: string; division_id?: string };
  if (!name?.trim()) return Response.json({ ok: false, error: '이름을 입력하세요' }, { status: 400 });

  const id   = randomUUID();
  const slug = name.toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-').replace(/-+/g,'-') + '-' + id.slice(0,6);
  const wsPath = path.join(WS_BASE, slug);

  for (const d of [wsPath, path.join(wsPath,'memory'), path.join(wsPath,'.claude','agents'), path.join(wsPath,'.claude','commands'), path.join(wsPath,'.claude','skills')]) {
    fs.mkdirSync(d, { recursive: true });
  }

  Workspaces.create({ id, name, path: wsPath, division_id: division_id ?? null });
  return Response.json({ ok: true, workspace: Workspaces.get(id) });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });
  Workspaces.delete(id);
  return Response.json({ ok: true });
}
