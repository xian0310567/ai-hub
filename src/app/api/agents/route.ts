import { NextRequest } from 'next/server';
import { Agents, Teams, Parts, Workspaces } from '@/lib/db';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';

export async function GET() {
  return Response.json({ ok: true, agents: Agents.listAll() });
}

// POST /api/agents
// org_level: 'department' | 'team' | 'part' | 'worker'
// 소속: team_id (팀장/팀워커) | part_id (파트장/파트워커) | parent_agent_id (서브에이전트)
export async function POST(req: NextRequest) {
  const {
    team_id, part_id, parent_agent_id, name,
    emoji = '🤖', color = '#6b7280',
    role = '', harness_pattern = 'orchestrator',
    org_level,
  } = await req.json() as {
    team_id?: string; part_id?: string; parent_agent_id?: string; name: string;
    emoji?: string; color?: string; role?: string; harness_pattern?: string;
    org_level?: string;
  };

  if (!name?.trim()) return Response.json({ ok: false, error: '이름 필수' }, { status: 400 });

  // workspace 결정
  let workspace_id: string;
  let wsPath: string;
  let resolvedTeamId = team_id ?? null;
  let resolvedPartId = part_id ?? null;
  let is_lead = 0;
  let level = org_level ?? 'worker';

  if (part_id) {
    const part = Parts.get(part_id);
    if (!part) return Response.json({ ok: false, error: '파트 없음' }, { status: 404 });
    const team = Teams.get(part.team_id);
    if (!team) return Response.json({ ok: false, error: '팀 없음' }, { status: 404 });
    workspace_id = team.workspace_id;
    resolvedTeamId = part.team_id;
    is_lead = parent_agent_id ? 0 : 1; // 파트에 직접 추가 = 파트장
    level = is_lead ? 'part' : 'worker';
  } else if (team_id) {
    const team = Teams.get(team_id);
    if (!team) return Response.json({ ok: false, error: '팀 없음' }, { status: 404 });
    workspace_id = team.workspace_id;
    is_lead = parent_agent_id ? 0 : 1; // 팀에 직접 추가 = 팀장
    level = is_lead ? 'team' : 'worker';
  } else if (parent_agent_id) {
    const parent = Agents.get(parent_agent_id);
    if (!parent) return Response.json({ ok: false, error: '부모 없음' }, { status: 404 });
    workspace_id = parent.workspace_id;
    resolvedTeamId = parent.team_id;
    resolvedPartId = parent.part_id;
    is_lead = 0;
    level = 'worker';
  } else {
    return Response.json({ ok: false, error: 'team_id / part_id / parent_agent_id 중 하나 필요' }, { status: 400 });
  }

  const ws = Workspaces.get(workspace_id);
  if (!ws) return Response.json({ ok: false, error: '워크스페이스 없음' }, { status: 404 });
  wsPath = ws.path;

  const id  = randomUUID();
  const cmd = name.toLowerCase().replace(/[^a-z0-9]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');

  ensureDirs(wsPath);

  if (is_lead) {
    fs.writeFileSync(path.join(wsPath, 'SOUL.md'), leadSoul(name, emoji, role, cmd, level), 'utf8');
    fs.writeFileSync(path.join(wsPath, '.claude','agents',`${cmd}.md`), leadAgentMd(name, cmd, role, harness_pattern, level), 'utf8');
  } else {
    fs.writeFileSync(path.join(wsPath, '.claude','agents',`${cmd}.md`), workerAgentMd(name, cmd, role), 'utf8');
    if (parent_agent_id) registerSubInLead(wsPath, parent_agent_id, name, cmd, role);
  }

  Agents.create({
    id, workspace_id,
    team_id: resolvedTeamId, part_id: resolvedPartId,
    parent_agent_id: parent_agent_id ?? null,
    org_level: level, is_lead, name, emoji, color,
    soul: '', command_name: cmd, harness_pattern,
  });

  return Response.json({ ok: true, agent: Agents.get(id) });
}

// DELETE /api/agents?id=xxx
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });
  Agents.delete(id);
  return Response.json({ ok: true });
}

// PATCH /api/agents
export async function PATCH(req: Request) {
  const { id, name, emoji, color } = await req.json();
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });
  if (!Agents.get(id)) return Response.json({ ok: false, error: '없음' }, { status: 404 });
  if (name)  Agents.update(id, { name });
  if (emoji) Agents.update(id, { emoji });
  if (color) Agents.update(id, { color });
  return Response.json({ ok: true, agent: Agents.get(id) });
}

// ── 헬퍼 ──────────────────────────────────────────────────────────────

function ensureDirs(wsPath: string) {
  for (const d of [
    path.join(wsPath,'.claude','agents'),
    path.join(wsPath,'.claude','commands'),
    path.join(wsPath,'memory'),
  ]) fs.mkdirSync(d, { recursive: true });
}

const LEVEL_KO: Record<string,string> = {
  division: '부문장', department: '실장', team: '팀장', part: '파트장', worker: '팀원',
};

function leadSoul(name: string, emoji: string, role: string, cmd: string, level: string): string {
  return `# SOUL.md — ${name} ${emoji}
당신은 ${name}입니다. ${role || `${LEVEL_KO[level]||'리더'}로서 팀을 이끕니다.`}

## 역할
- 상위에서 위임된 업무 또는 사용자의 직접 요청을 받아 처리합니다.
- 하위 조직/에이전트에게 업무를 위임하고 결과를 통합합니다.

slash command: /${cmd}
`;
}

function leadAgentMd(name: string, cmd: string, role: string, pattern: string, level: string): string {
  return `---
name: ${cmd}
description: "${name} — ${LEVEL_KO[level]||'리더'}. ${role || '하위 조직 업무 총괄 및 위임'}. 관련 업무 요청 시 사용."
---

당신은 **${name}** (${LEVEL_KO[level]||'리더'})입니다.
${role ? `\n역할: ${role}\n` : ''}
## 업무 처리 원칙
1. 사용자 요청을 분석하여 어떤 하위 에이전트에게 위임할지 판단합니다.
2. 각 에이전트에게 명확한 지시를 내립니다.
3. 결과를 종합하여 완성된 답변을 제공합니다.

## 하위 조직/에이전트
(하위 에이전트가 추가되면 자동으로 등록됩니다)
`;
}

function workerAgentMd(name: string, cmd: string, role: string): string {
  return `---
name: ${cmd}
description: "${name} — ${role || '전문 처리 에이전트'}. 위임받은 작업을 처리한다."
---

당신은 **${name}**입니다. ${role || '전문화된 업무를 담당합니다.'}

## 처리 원칙
- 맡은 작업에 집중합니다.
- 결과는 명확하고 구조화된 형태로 반환합니다.
`;
}

function registerSubInLead(wsPath: string, parentId: string, subName: string, subCmd: string, subRole: string) {
  try {
    const agentsDir = path.join(wsPath, '.claude', 'agents');
    if (!fs.existsSync(agentsDir)) return;
    for (const f of fs.readdirSync(agentsDir).filter(f=>f.endsWith('.md'))) {
      const fp = path.join(agentsDir, f);
      const content = fs.readFileSync(fp, 'utf8');
      if (content.includes('하위 조직/에이전트')) {
        const updated = content.replace('(하위 에이전트가 추가되면 자동으로 등록됩니다)\n','').trimEnd();
        const entry = `- **${subName}** (/${subCmd}): ${subRole || '전문 처리'}`;
        if (!updated.includes(entry)) fs.writeFileSync(fp, updated+'\n'+entry+'\n', 'utf8');
        break;
      }
    }
  } catch {}
}
