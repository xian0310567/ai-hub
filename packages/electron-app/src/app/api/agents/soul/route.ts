import { NextRequest } from 'next/server';
import { getSession, getVmSessionCookie } from '@/lib/auth';
import path from 'path';
import fs from 'fs';

const VM_URL = process.env.VM_SERVER_URL || 'http://localhost:4000';

interface VmAgent {
  id: string; org_level?: string; workspace_id: string;
  is_lead: number; command_name?: string; soul?: string;
}

async function fetchAgent(agentId: string, cookie: string): Promise<VmAgent | null> {
  try {
    const res = await fetch(`${VM_URL}/api/agents/${agentId}`, { headers: { Cookie: cookie } });
    if (!res.ok) return null;
    return res.json() as Promise<VmAgent>;
  } catch { return null; }
}

async function fetchWsPath(workspaceId: string, cookie: string, isDivision: boolean): Promise<string | null> {
  try {
    const ep = isDivision ? `/api/divisions/${workspaceId}` : `/api/workspaces/${workspaceId}`;
    const res = await fetch(`${VM_URL}${ep}`, { headers: { Cookie: cookie } });
    if (!res.ok) return null;
    const data = await res.json() as { path?: string; ws_path?: string };
    return data.ws_path ?? data.path ?? null;
  } catch { return null; }
}

function readSoul(wsPath: string, cmdName: string | null): string {
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
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });

  const cookie = getVmSessionCookie(req);
  const agent = await fetchAgent(id, cookie);
  if (!agent) return Response.json({ ok: false, error: '없음' }, { status: 404 });

  const isDivision = agent.org_level === 'division';
  const wsPath = await fetchWsPath(agent.workspace_id, cookie, isDivision);
  const soul = wsPath ? readSoul(wsPath, agent.command_name ?? null) : (agent.soul ?? '');

  return Response.json({ ok: true, soul });
}

// PATCH /api/agents/soul — 소울 파일 저장
export async function PATCH(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { id, soul } = await req.json();
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });

  const cookie = getVmSessionCookie(req);
  const agent = await fetchAgent(id, cookie);
  if (!agent) return Response.json({ ok: false, error: '없음' }, { status: 404 });

  // vm-server DB 업데이트
  await fetch(`${VM_URL}/api/agents`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id, soul }),
  });

  // 파일 업데이트
  const isDivision = agent.org_level === 'division';
  const wsPath = await fetchWsPath(agent.workspace_id, cookie, isDivision);
  if (wsPath) {
    const soulFile = path.join(wsPath, agent.is_lead ? 'SOUL.md' : path.join('.claude', 'agents', `${agent.command_name || 'agent'}.md`));
    try {
      fs.mkdirSync(path.dirname(soulFile), { recursive: true });
      fs.writeFileSync(soulFile, soul, 'utf8');
      if (agent.is_lead) {
        const claudeMd = path.join(wsPath, 'CLAUDE.md');
        if (!fs.existsSync(claudeMd)) fs.writeFileSync(claudeMd, soul, 'utf8');
      }
    } catch {}
  }

  return Response.json({ ok: true });
}
