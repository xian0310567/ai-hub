import { NextRequest } from 'next/server';
import { Divisions, Workspaces, Teams, Agents } from '@/lib/db';
import { getSession, getUserWorkspacesDir } from '@/lib/auth';
import db from '@/lib/db';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';

// GET /api/divisions — 전체 조직도 (부문 > 실 > 팀 > 파트 > 에이전트)
export async function GET(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const divisions = Divisions.list(user.id).map(div => {
    const depts = Workspaces.listByDiv(div.id).map(ws => buildDept(ws, user.id));
    const lead  = Agents.listByUser(user.id).find(a => a.org_level === 'division' && a.workspace_id === div.id);
    return { ...div, lead: lead ?? null, departments: depts };
  });
  const standalone = Workspaces.listUnassigned(user.id).map(ws => buildDept(ws, user.id));
  return Response.json({ ok: true, divisions, standalone });
}

function buildDept(ws: any, userId: string) {
  const lead  = Agents.listByUser(userId).find(a => a.org_level === 'department' && a.workspace_id === ws.id);
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

// POST /api/divisions — 부문 생성 (부문장 자동 생성 포함)
export async function POST(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { name, color = '#7c3aed' } = await req.json() as { name: string; color?: string };
  if (!name?.trim()) return Response.json({ ok: false, error: '부문명을 입력하세요' }, { status: 400 });

  const WS_BASE = getUserWorkspacesDir(user.id);
  const id = randomUUID();
  const wsPath = path.join(WS_BASE, `division-${name.toLowerCase().replace(/[^a-z0-9가-힣]/g,'-')}-${id.slice(0,6)}`);
  for (const d of [wsPath, path.join(wsPath,'.claude','agents'), path.join(wsPath,'.claude','commands'), path.join(wsPath,'memory')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  Divisions.create({ id, name, color, ws_path: wsPath, user_id: user.id });

  // 부문장 자동 생성 (기본 소울)
  const defaultSoul = `## 정체성\n당신은 "${name}" 부문의 부문장입니다.\n\n## 핵심 역할\n- 산하 실들의 업무를 총괄하고 조율합니다.\n- 사용자에게 부문 현황을 보고합니다.\n\n## 보고 형식\n핵심 요약 → 실별 현황 → 제언`;
  fs.writeFileSync(path.join(wsPath, 'CLAUDE.md'), defaultSoul, 'utf8');

  const agentId = randomUUID();
  Agents.create({
    id: agentId,
    workspace_id: id,
    team_id: null, part_id: null, parent_agent_id: null,
    org_level: 'division', is_lead: 1,
    name: `${name}장`, emoji: '👔', color,
    soul: defaultSoul, command_name: null, harness_pattern: 'orchestrator',
    user_id: user.id,
  });

  // Claude CLI로 소울 자동 생성 (백그라운드)
  setImmediate(() => {
    try {
      const prompt = `당신은 AI 회사 에이전트 시스템의 설계자입니다.
"${name}" 부문의 부문장 에이전트 SOUL.md를 한국어로 작성해주세요.

부문장의 역할: 산하 실장들을 통해 부문 전체 업무를 조율하고 사용자에게 보고하는 최상위 관리자

SOUL.md 작성 규칙:
1. ## 정체성, ## 핵심 역할, ## 업무 처리 원칙, ## 보고 형식 섹션 포함
2. "${name}" 부문의 특성에 맞게 구체적으로 작성
3. 실용적이고 명확하게, 150~250 단어

SOUL.md 내용만 출력 (설명 없이):`;
      const result = execFileSync('claude', ['-p', prompt], { cwd: wsPath, encoding: 'utf8', timeout: 60000, env: { ...process.env } });
      const soul = result.trim();
      if (soul && soul.length > 50) {
        fs.writeFileSync(path.join(wsPath, 'CLAUDE.md'), soul, 'utf8');
        Agents.update(agentId, { soul });
      }
    } catch {}
  });

  return Response.json({ ok: true, division: Divisions.get(id) });
}

// PATCH /api/divisions — 부문 수정
export async function PATCH(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { id, name, color } = await req.json();
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });

  const div = Divisions.get(id);
  if (!div || div.user_id !== user.id) return Response.json({ ok: false, error: '없음' }, { status: 404 });

  if (name)  db.prepare('UPDATE divisions SET name=? WHERE id=?').run(name, id);
  if (color) db.prepare('UPDATE divisions SET color=? WHERE id=?').run(color, id);
  return Response.json({ ok: true });
}

// DELETE /api/divisions?id=xxx
export async function DELETE(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });

  const div = Divisions.get(id);
  if (!div || div.user_id !== user.id) return Response.json({ ok: false, error: '없음' }, { status: 404 });

  Divisions.delete(id);
  return Response.json({ ok: true });
}
