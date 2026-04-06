import { NextRequest } from 'next/server';
import { Workspaces, Agents } from '@/lib/db';
import { getSession, getUserWorkspacesDir } from '@/lib/auth';
import db from '@/lib/db';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';

// GET /api/workspaces — 목록
export async function GET(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const workspaces = Workspaces.listByUser(user.id);
  const result = workspaces.map(ws => ({ ...ws, agents: Agents.list(ws.id) }));
  return Response.json({ ok: true, workspaces: result });
}

// POST /api/workspaces — 생성
export async function POST(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { name, division_id } = await req.json() as { name: string; division_id?: string };
  if (!name?.trim()) return Response.json({ ok: false, error: '이름을 입력하세요' }, { status: 400 });

  const WS_BASE = getUserWorkspacesDir(user.id);
  const id   = randomUUID();
  const slug = name.toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-') + '-' + id.slice(0,6);
  const wsPath = path.join(WS_BASE, slug);

  for (const d of [wsPath, path.join(wsPath,'memory'), path.join(wsPath,'.claude','agents'), path.join(wsPath,'.claude','commands'), path.join(wsPath,'.claude','skills')]) {
    fs.mkdirSync(d, { recursive: true });
  }

  Workspaces.create({ id, name, path: wsPath, division_id: division_id ?? null, user_id: user.id });

  // 실장 자동 생성 (기본 소울)
  const defaultSoul = `## 정체성\n당신은 "${name}" 실의 실장입니다.\n\n## 핵심 역할\n- 산하 팀들의 업무를 조율하고 취합합니다.\n- 상위 부문장에게 실 현황을 보고합니다.\n\n## 보고 형식\n핵심 요약 → 팀별 현황 → 제언`;
  fs.writeFileSync(path.join(wsPath, 'CLAUDE.md'), defaultSoul, 'utf8');

  const agentId = randomUUID();
  Agents.create({
    id: agentId,
    workspace_id: id,
    team_id: null, part_id: null, parent_agent_id: null,
    org_level: 'department', is_lead: 1,
    name: `${name}장`, emoji: '🏢', color: '#4f46e5',
    soul: defaultSoul, command_name: null, harness_pattern: 'orchestrator',
    user_id: user.id,
  });

  // Claude CLI로 소울 자동 생성 (백그라운드)
  setImmediate(() => {
    try {
      const prompt = `당신은 AI 회사 에이전트 시스템의 설계자입니다.
"${name}" 실의 실장 에이전트 SOUL.md를 한국어로 작성해주세요.

실장의 역할: 산하 팀장들을 통해 실 전체 업무를 조율하고 부문장에게 보고하는 중간 관리자

SOUL.md 작성 규칙:
1. ## 정체성, ## 핵심 역할, ## 업무 처리 원칙, ## 보고 형식 섹션 포함
2. "${name}" 실의 특성에 맞게 구체적으로 작성
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

  return Response.json({ ok: true, workspace: Workspaces.get(id) });
}

// PATCH /api/workspaces — 수정
export async function PATCH(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { id, name } = await req.json();
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });

  const ws = Workspaces.get(id);
  if (!ws || ws.user_id !== user.id) return Response.json({ ok: false, error: '없음' }, { status: 404 });

  if (name) db.prepare('UPDATE workspaces SET name=? WHERE id=?').run(name, id);
  return Response.json({ ok: true, workspace: Workspaces.get(id) });
}

// DELETE /api/workspaces?id=xxx
export async function DELETE(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });

  const ws = Workspaces.get(id);
  if (!ws || ws.user_id !== user.id) return Response.json({ ok: false, error: '없음' }, { status: 404 });

  Workspaces.delete(id);
  return Response.json({ ok: true });
}
