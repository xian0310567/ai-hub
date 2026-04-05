import { NextRequest } from 'next/server';
import { Divisions, Workspaces, Teams, Agents } from '@/lib/db';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';

const WS_BASE = process.env.WORKSPACES_DIR || path.join(process.cwd(), '.data', 'workspaces');

// GET /api/divisions — 전체 조직도 (부문 > 실 > 팀 > 파트 > 에이전트)
export async function GET() {
  const divisions = Divisions.listAll().map(div => {
    const depts = Workspaces.listByDiv(div.id).map(ws => buildDept(ws));
    const lead  = Agents.listAll().find(a => a.org_level === 'division' && a.workspace_id === div.id);
    return { ...div, lead: lead ?? null, departments: depts };
  });
  // 어느 부문에도 속하지 않은 실 (독립 실)
  const standalone = Workspaces.listUnassigned().map(ws => buildDept(ws));
  return Response.json({ ok: true, divisions, standalone });
}

function buildDept(ws: any) {
  const lead  = Agents.listAll().find(a => a.org_level === 'department' && a.workspace_id === ws.id);
  const teams = Teams.list(ws.id).map(team => {
    const teamLead = Agents.listByTeam(team.id).find(a => a.is_lead === 1);
    const workers  = Agents.listByTeam(team.id).filter(a => a.is_lead === 0);
    const { Parts } = require('@/lib/db');
    const parts = Parts.list(team.id).map((part: any) => {
      const partLead    = Agents.listByPart(part.id).find((a: any) => a.is_lead === 1);
      const partWorkers = Agents.listByPart(part.id).filter((a: any) => a.is_lead === 0);
      return { ...part, lead: partLead ?? null, workers: partWorkers };
    });
    return { ...team, lead: teamLead ?? null, workers, parts };
  });
  return { ...ws, lead: lead ?? null, teams };
}

// POST /api/divisions — 부문 생성
export async function POST(req: NextRequest) {
  const { name, color = '#7c3aed' } = await req.json() as { name: string; color?: string };
  if (!name?.trim()) return Response.json({ ok: false, error: '부문명을 입력하세요' }, { status: 400 });

  const id = randomUUID();
  const wsPath = path.join(WS_BASE, `division-${name.toLowerCase().replace(/[^a-z0-9가-힣]/g,'-')}-${id.slice(0,6)}`);
  for (const d of [wsPath, path.join(wsPath,'.claude','agents'), path.join(wsPath,'.claude','commands'), path.join(wsPath,'memory')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  Divisions.create({ id, name, color, ws_path: wsPath });
  return Response.json({ ok: true, division: Divisions.get(id) });
}

// DELETE /api/divisions?id=xxx
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });
  Divisions.delete(id);
  return Response.json({ ok: true });
}
