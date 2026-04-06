import { NextRequest } from 'next/server';
import { Missions, Divisions, Workspaces, Teams, Parts, Agents, Notifications } from '@/lib/db';
import { getSession } from '@/lib/auth';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';

// GET /api/missions — 미션 목록
export async function GET(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const missions = Missions.list(user.id);
  return Response.json({ ok: true, missions });
}

// POST /api/missions — 미션 생성 (즉시 응답 + 백그라운드 라우팅 분석)
export async function POST(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { task } = await req.json() as { task: string };
  if (!task?.trim()) return Response.json({ ok: false, error: '미션 설명을 입력하세요' }, { status: 400 });

  // 현재 조직도 구축
  const orgChart = buildOrgChart(user.id);
  if (!orgChart.trim()) {
    return Response.json({ ok: false, error: '조직이 없습니다. 먼저 조직을 만드세요.' }, { status: 400 });
  }

  // 미션 레코드 즉시 생성 (status: 'analyzing')
  const id = randomUUID();
  Missions.create({ id, user_id: user.id, task, routing: '[]' });
  Missions.update(id, { status: 'analyzing' });

  // 즉시 응답 — 클라이언트는 폴링으로 결과 수신
  const response = Response.json({
    ok: true,
    mission: { id, task, status: 'analyzing' },
  });

  // 백그라운드에서 Claude CLI 라우팅 분석
  const anyWs = Workspaces.listByUser(user.id)[0];
  const anyDiv = Divisions.list(user.id)[0];
  const cwd = anyWs?.path || anyDiv?.ws_path || process.cwd();

  const prompt = buildRoutingPrompt(orgChart, task);

  setImmediate(() => {
    execFile('claude', ['-p', prompt], {
      cwd,
      encoding: 'utf8',
      timeout: 90000,
      env: { ...process.env },
    }, (err, stdout) => {
      if (err) {
        Missions.update(id, { status: 'routing_failed' });
        return;
      }

      try {
        const cleaned = stdout.trim().replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
        const parsed = JSON.parse(cleaned);

        // 새 조직이 필요하면 알림 생성
        for (const orgName of (parsed.new_org_needed || [])) {
          Notifications.create({
            id: randomUUID(),
            user_id: user.id,
            type: 'org_needed',
            title: `${orgName} 생성 권장`,
            message: `미션 "${task.slice(0, 50)}..."에서 ${orgName}이(가) 필요했지만 현재 조직에 없습니다.`,
            read: 0,
          });
        }

        // 미션 업데이트 — routing, summary, clarification 포함
        Missions.update(id, {
          routing: JSON.stringify(parsed.routing || []),
          status: parsed.needs_clarification ? 'needs_clarification' : 'routed',
        });

        // clarification / summary를 steps 필드에 임시 저장 (JSON)
        const meta = {
          summary: parsed.summary,
          needs_clarification: parsed.needs_clarification || false,
          clarification: parsed.clarification || null,
          new_org_needed: parsed.new_org_needed || [],
        };
        Missions.update(id, { steps: JSON.stringify(meta) });
      } catch {
        Missions.update(id, { status: 'routing_failed' });
      }
    });
  });

  return response;
}

// PATCH /api/missions — routing 업데이트 (clarification 옵션 선택 시)
export async function PATCH(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  const { id, extra_routing } = await req.json();
  const m = Missions.get(id);
  if (!m || m.user_id !== user.id) return Response.json({ ok: false, error: '없음' }, { status: 404 });
  const existing = JSON.parse(m.routing || '[]');
  const merged = [...existing, ...(extra_routing || [])];
  Missions.update(id, { routing: JSON.stringify(merged), status: 'routed' });
  return Response.json({ ok: true, routing: merged });
}

// DELETE /api/missions?id=xxx
export async function DELETE(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });

  const m = Missions.get(id);
  if (!m || m.user_id !== user.id) return Response.json({ ok: false, error: '없음' }, { status: 404 });

  Missions.delete(id);
  return Response.json({ ok: true });
}

// ── 라우팅 프롬프트 생성 ────────────────────────────────────────────
function buildRoutingPrompt(orgChart: string, task: string): string {
  return `당신은 AI 조직의 미션 라우터입니다. 사용자의 업무 요청을 분석하고 어떤 조직/팀에 어떤 업무를 배정할지 결정합니다.

## 현재 조직도
${orgChart}

## 사용자 요청
${task}

## 요청
위 업무를 처리할 수 있는 조직에 배정하고, 처리할 수 없는 업무 영역이 있으면 대안을 제시하세요.

반드시 아래 JSON 형식으로만 답변하세요 (다른 텍스트 없이):

{
  "summary": "미션 요약 (1문장)",
  "routing": [
    {
      "org_id": "조직 ID",
      "org_type": "division | department | team",
      "org_name": "조직 이름",
      "agent_id": "담당 리더 에이전트 ID",
      "agent_name": "담당 리더 에이전트 이름",
      "subtask": "이 조직에 배정할 구체적인 업무 설명 (2-4문장)"
    }
  ],
  "needs_clarification": false,
  "clarification": null,
  "new_org_needed": []
}

만약 이 업무를 처리할 조직이 없거나 일부 업무 영역을 처리할 조직이 없다면:
{
  "summary": "미션 요약",
  "routing": [...현재 처리 가능한 부분의 라우팅...],
  "needs_clarification": true,
  "clarification": {
    "gap": "처리하지 못하는 업무 영역 설명",
    "options": [
      {
        "id": "opt1",
        "label": "기존 조직에서 임시 담당",
        "description": "설명",
        "extra_routing": [...]
      },
      {
        "id": "opt2",
        "label": "해당 부분 건너뛰기",
        "description": "설명",
        "extra_routing": []
      },
      {
        "id": "opt3",
        "label": "전체 취소 후 조직 구성 먼저",
        "description": "설명",
        "extra_routing": []
      }
    ]
  },
  "new_org_needed": ["기획부문", "마케팅팀"]
}

라우팅 원칙:
- 1개 조직으로 충분하면 1개만
- 교차 협업이 필요하면 2-3개까지
- 각 subtask는 해당 조직이 독립적으로 수행 가능해야 함
- 조직 ID와 에이전트 ID는 반드시 위 조직도에 있는 실제 ID를 사용`;
}

// ── 조직도 텍스트 생성 ──────────────────────────────────────────────
function buildOrgChart(userId: string): string {
  const lines: string[] = [];
  const divs = Divisions.list(userId);
  const allAgents = Agents.listByUser(userId);

  for (const div of divs) {
    const divLead = allAgents.find(a => a.org_level === 'division' && a.workspace_id === div.id);
    lines.push(`◉ 부문: ${div.name} (id: ${div.id})`);
    if (divLead) lines.push(`  리더: ${divLead.emoji} ${divLead.name} (agent_id: ${divLead.id})`);

    const depts = Workspaces.listByDiv(div.id);
    for (const dept of depts) {
      const deptLead = allAgents.find(a => a.org_level === 'department' && a.workspace_id === dept.id);
      lines.push(`  🏢 실: ${dept.name} (id: ${dept.id})`);
      if (deptLead) lines.push(`    리더: ${deptLead.emoji} ${deptLead.name} (agent_id: ${deptLead.id})`);

      const teams = Teams.list(dept.id);
      for (const team of teams) {
        const teamAgents = Agents.listByTeam(team.id);
        const teamLead = teamAgents.find(a => a.is_lead === 1);
        const workers = teamAgents.filter(a => a.is_lead === 0);
        lines.push(`    ▸ 팀: ${team.name} (id: ${team.id})${team.description ? ' — ' + team.description : ''}`);
        if (teamLead) lines.push(`      리더: ${teamLead.emoji} ${teamLead.name} (agent_id: ${teamLead.id})`);
        for (const w of workers) lines.push(`      팀원: ${w.emoji} ${w.name} (agent_id: ${w.id})`);

        const parts = Parts.list(team.id);
        for (const part of parts) {
          const partAgents = Agents.listByPart(part.id);
          const partLead = partAgents.find(a => a.is_lead === 1);
          const pWorkers = partAgents.filter(a => a.is_lead === 0);
          lines.push(`      ◆ 파트: ${part.name} (id: ${part.id})`);
          if (partLead) lines.push(`        리더: ${partLead.emoji} ${partLead.name} (agent_id: ${partLead.id})`);
          for (const w of pWorkers) lines.push(`        팀원: ${w.emoji} ${w.name} (agent_id: ${w.id})`);
        }
      }
    }
  }

  // 독립 실
  const standalone = Workspaces.listUnassigned(userId);
  for (const dept of standalone) {
    const deptLead = allAgents.find(a => a.org_level === 'department' && a.workspace_id === dept.id);
    lines.push(`🏢 독립 실: ${dept.name} (id: ${dept.id})`);
    if (deptLead) lines.push(`  리더: ${deptLead.emoji} ${deptLead.name} (agent_id: ${deptLead.id})`);

    const teams = Teams.list(dept.id);
    for (const team of teams) {
      const teamAgents = Agents.listByTeam(team.id);
      const teamLead = teamAgents.find(a => a.is_lead === 1);
      const workers = teamAgents.filter(a => a.is_lead === 0);
      lines.push(`  ▸ 팀: ${team.name} (id: ${team.id})`);
      if (teamLead) lines.push(`    리더: ${teamLead.emoji} ${teamLead.name} (agent_id: ${teamLead.id})`);
      for (const w of workers) lines.push(`    팀원: ${w.emoji} ${w.name} (agent_id: ${w.id})`);
    }
  }

  return lines.join('\n');
}
