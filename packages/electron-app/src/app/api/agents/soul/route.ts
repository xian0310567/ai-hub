import { NextRequest } from 'next/server';
import { Agents, Workspaces, Divisions } from '@/lib/db';
import { getSession } from '@/lib/auth';
import path from 'path';
import fs from 'fs';

function getWsPath(agent: ReturnType<typeof Agents.get>): string | null {
  if (!agent) return null;
  const ws = Workspaces.get(agent.workspace_id);
  if (ws) return ws.path;
  const div = Divisions.get(agent.workspace_id);
  return div?.ws_path ?? null;
}

function readSoul(wsPath: string, cmdName: string | null): string {
  // 우선순위: SOUL.md → CLAUDE.md → .claude/agents/{cmd}.md
  const candidates = [
    path.join(wsPath, 'SOUL.md'),
    path.join(wsPath, 'CLAUDE.md'),
    ...(cmdName ? [path.join(wsPath, '.claude', 'agents', `${cmdName}.md`)] : []),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  }
  return '';
}

// GET /api/agents/soul?id=xxx
export async function GET(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });

  const agent = Agents.get(id);
  if (!agent || agent.user_id !== user.id) return Response.json({ ok: false, error: '없음' }, { status: 404 });

  const wsPath = getWsPath(agent);
  const soul = wsPath ? readSoul(wsPath, agent.command_name) : agent.soul;

  return Response.json({ ok: true, soul });
}

// PATCH /api/agents/soul — 소울 파일 저장
export async function PATCH(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { id, soul } = await req.json();
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });

  const agent = Agents.get(id);
  if (!agent || agent.user_id !== user.id) return Response.json({ ok: false, error: '없음' }, { status: 404 });

  // DB 업데이트
  Agents.update(id, { soul });

  // 파일 업데이트
  const wsPath = getWsPath(agent);
  if (wsPath) {
    const soulFile = path.join(wsPath, agent.is_lead ? 'SOUL.md' : path.join('.claude', 'agents', `${agent.command_name || 'agent'}.md`));
    try {
      fs.mkdirSync(path.dirname(soulFile), { recursive: true });
      fs.writeFileSync(soulFile, soul, 'utf8');
      // is_lead면 CLAUDE.md도 동기화
      if (agent.is_lead) {
        const claudeMd = path.join(wsPath, 'CLAUDE.md');
        if (!fs.existsSync(claudeMd)) fs.writeFileSync(claudeMd, soul, 'utf8');
      }
    } catch {}
  }

  return Response.json({ ok: true });
}
