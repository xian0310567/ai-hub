import { NextRequest } from 'next/server';
import { Agents, Teams, Parts, Workspaces, Divisions } from '@/lib/db';
import db from '@/lib/db';
import { getSession } from '@/lib/auth';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';

// ── 하네스 패턴 지식 (팀 전용) ──────────────────────────────────────
const HARNESS_KNOWLEDGE = `
## 멀티 에이전트 하네스 패턴 (Harness Patterns)

### 1. orchestrator (오케스트레이터)
팀장처럼 일을 나눠주고 결과를 취합하는 리더 에이전트.
하위 에이전트에게 Task를 위임하고 최종 결과를 통합함.
언제: 리더, 팀장 포지션

### 2. pipeline (파이프라인)
컨베이어 벨트처럼 순서대로 처리. 앞 에이전트의 출력이 다음의 입력이 됨.
언제: 기획→설계→개발→QA처럼 단계가 명확한 작업

### 3. scatter-gather (스캐터/게더, fan-out)
여러 에이전트에게 동시에 던지고 결과를 모아서 통합.
언제: 병렬 리서치, 다양한 관점 분석, A/B 비교

### 4. worker-pool (워커 풀, expert-pool)
요청 성격에 따라 적합한 전문 에이전트를 동적으로 선택.
언제: 다양한 종류의 요청이 섞여 들어올 때 라우팅

### 5. check-fix (체크/픽스, producer-reviewer)
결과물을 검증하고 통과할 때까지 반복 수정. 최대 3회 반복.
언제: 코드 품질, 테스트, 형식 검증이 필요한 실무 작업

### 6. single (단독)
위임 없이 혼자 처리하고 바로 답변.
언제: 전문 실무자, 특정 도메인 전문가 (개발자, 디자이너 등)
`;

// ── POST /api/harness — 설계 요청 ────────────────────────────────────
// 부문/실: 리더 역할 정의 (소울 생성)
// 팀: 멀티 에이전트 팀 구조 설계
export async function POST(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { task, org_id, org_type, org_name } = await req.json() as {
    task: string;
    org_id: string;
    org_type: 'division' | 'department' | 'team';
    org_name: string;
  };
  if (!task?.trim()) return Response.json({ ok: false, error: '업무 설명을 입력하세요' }, { status: 400 });

  // 워크스페이스 경로 확인
  let wsPath: string | null = null;
  if (org_type === 'division') {
    wsPath = Divisions.get(org_id)?.ws_path ?? null;
  } else if (org_type === 'department') {
    wsPath = Workspaces.get(org_id)?.path ?? null;
  } else {
    const team = Teams.get(org_id);
    const ws = team ? Workspaces.get(team.workspace_id) : null;
    wsPath = ws?.path ?? null;
  }
  if (!wsPath) return Response.json({ ok: false, error: '조직을 찾을 수 없습니다' }, { status: 404 });

  // ── 부문/실: 리더 역할 정의 ──
  if (org_type === 'division' || org_type === 'department') {
    const levelKo = org_type === 'division' ? '부문장' : '실장';
    const prompt = `당신은 AI 회사 조직 설계 전문가입니다.

## 설계 대상
- 조직: ${org_name} (${org_type === 'division' ? '부문' : '실'})
- 직책: ${levelKo}

## 사용자가 설명한 이 조직의 역할
${task}

## 요청
위 설명을 바탕으로 이 ${levelKo}의 역할을 정의해주세요.

반드시 아래 JSON 형식으로만 답변하세요 (다른 텍스트 없이):

{
  "name": "${levelKo} 이름 (예: ${org_name}장)",
  "emoji": "역할에 맞는 이모지 1개",
  "color": "#hex색상코드",
  "role_summary": "이 ${levelKo}의 핵심 역할 한 줄 요약",
  "soul": "## 정체성\\n(누구인지)\\n\\n## 핵심 역할\\n(구체적 책임 3-5개, 각각 - 로 시작)\\n\\n## 업무 처리 원칙\\n(원칙 3-4개)\\n\\n## 산하 조직 관리\\n(어떻게 하위 조직을 관리하는지)\\n\\n## 보고 형식\\n(보고 구조)"
}

작성 원칙:
- "${org_name}" 조직의 특성에 맞게 구체적으로
- 소울은 200~350 단어
- 한국어로 작성`;

    try {
      const result = execFileSync('claude', ['-p', prompt], {
        cwd: wsPath, encoding: 'utf8', timeout: 90000, env: { ...process.env },
      });
      const cleaned = result.trim().replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'');
      const design = JSON.parse(cleaned);
      return Response.json({ ok: true, design, mode: 'leader' });
    } catch (e: any) {
      return Response.json({ ok: false, error: `설계 실패: ${e.message}` }, { status: 500 });
    }
  }

  // ── 팀: 멀티 에이전트 구조 설계 ──
  const prompt = `당신은 멀티 에이전트 시스템 설계 전문가입니다.

${HARNESS_KNOWLEDGE}

## 설계 대상 조직
- 조직명: ${org_name}
- 조직 유형: 팀

## 사용자 업무 설명
${task}

## 요청
위 업무를 수행하기에 가장 적합한 에이전트 팀 구조를 설계해주세요.

반드시 아래 JSON 형식으로만 답변하세요 (다른 텍스트 없이):

{
  "pattern": "orchestrator | pipeline | scatter-gather | worker-pool | check-fix | single",
  "reasoning": "이 패턴을 선택한 이유 (2-3문장)",
  "agents": [
    {
      "name": "에이전트 이름 (예: 개발팀장, BE개발자, QA엔지니어)",
      "emoji": "역할에 맞는 이모지",
      "role": "이 에이전트의 구체적인 역할과 책임 (2-3문장)",
      "harness_pattern": "이 에이전트 개인의 패턴 (orchestrator/single/check-fix 등)",
      "model": "claude-sonnet-4-5",
      "color": "#hex색상코드",
      "is_lead": true 또는 false
    }
  ]
}

설계 원칙:
- 팀장은 반드시 1명, harness_pattern은 orchestrator
- 실무자는 single 또는 check-fix
- 에이전트는 최소 2명, 최대 15명 (사용자가 지정한 수 우선)
- 사용자가 요청한 에이전트 수를 정확히 따르세요. 사용자가 BE 3, FE 2처럼 구체적인 수를 요청하면 그 수를 정확히 따르세요. 같은 역할에 여러 에이전트를 만들 수 있습니다.
- 한국어 이름 사용`;

  try {
    const result = execFileSync('claude', ['-p', prompt], {
      cwd: wsPath, encoding: 'utf8', timeout: 90000, env: { ...process.env },
    });
    const cleaned = result.trim().replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'');
    const design = JSON.parse(cleaned);
    return Response.json({ ok: true, design, mode: 'team' });
  } catch (e: any) {
    return Response.json({ ok: false, error: `설계 실패: ${e.message}` }, { status: 500 });
  }
}

// ── PATCH /api/harness — 적용 ────────────────────────────────────────
export async function PATCH(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { org_id, org_type, org_name, task, design, mode } = await req.json() as {
    org_id: string;
    org_type: 'division' | 'department' | 'team';
    org_name?: string;
    task?: string;
    design: any;
    mode: 'leader' | 'team';
  };

  // ── 부문/실: 리더 1명만 생성/업데이트 ──
  if (mode === 'leader') {
    let wsPath: string;

    if (org_type === 'division') {
      const div = Divisions.get(org_id);
      if (!div) return Response.json({ ok: false, error: '부문 없음' }, { status: 404 });
      wsPath = div.ws_path;

      // 기존 부문장 찾기
      const existing = Agents.listByUser(user.id).find(a => a.org_level === 'division' && a.workspace_id === org_id);

      const soul = design.soul || '';
      const name = design.name || `${org_name}장`;
      const cmd = name.toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

      fs.mkdirSync(path.join(wsPath, '.claude', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(wsPath, 'SOUL.md'), soul, 'utf8');
      fs.writeFileSync(path.join(wsPath, '.claude', 'agents', `${cmd}.md`),
        `---\nname: ${cmd}\ndescription: "${name}"\n---\n\n${soul}`, 'utf8');

      if (existing) {
        Agents.update(existing.id, { name, emoji: design.emoji || existing.emoji, color: design.color || existing.color, soul, command_name: cmd });
      } else {
        Agents.create({
          id: randomUUID(), workspace_id: org_id, team_id: null, part_id: null,
          parent_agent_id: null, org_level: 'division', is_lead: 1,
          name, emoji: design.emoji || '👔', color: design.color || '#7c3aed',
          soul, command_name: cmd, harness_pattern: 'orchestrator',
          model: 'claude-opus-4-5', user_id: user.id,
        });
      }

      // harness_prompt 저장
      if (task) db.prepare('UPDATE divisions SET harness_prompt=? WHERE id=?').run(task, org_id);

      return Response.json({ ok: true, created: [name] });

    } else {
      // department
      const ws = Workspaces.get(org_id);
      if (!ws || ws.user_id !== user.id) return Response.json({ ok: false, error: '실 없음' }, { status: 404 });
      wsPath = ws.path;

      const existing = Agents.listByUser(user.id).find(a => a.org_level === 'department' && a.workspace_id === org_id);

      const soul = design.soul || '';
      const name = design.name || `${org_name}장`;
      const cmd = name.toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

      fs.mkdirSync(path.join(wsPath, '.claude', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(wsPath, 'SOUL.md'), soul, 'utf8');
      fs.writeFileSync(path.join(wsPath, '.claude', 'agents', `${cmd}.md`),
        `---\nname: ${cmd}\ndescription: "${name}"\n---\n\n${soul}`, 'utf8');

      if (existing) {
        Agents.update(existing.id, { name, emoji: design.emoji || existing.emoji, color: design.color || existing.color, soul, command_name: cmd });
      } else {
        Agents.create({
          id: randomUUID(), workspace_id: org_id, team_id: null, part_id: null,
          parent_agent_id: null, org_level: 'department', is_lead: 1,
          name, emoji: design.emoji || '👔', color: design.color || '#6366f1',
          soul, command_name: cmd, harness_pattern: 'orchestrator',
          model: 'claude-opus-4-5', user_id: user.id,
        });
      }

      if (task) db.prepare('UPDATE workspaces SET harness_prompt=? WHERE id=?').run(task, org_id);

      return Response.json({ ok: true, created: [name] });
    }
  }

  // ── 팀: 멀티 에이전트 생성 ──
  const team = Teams.get(org_id);
  if (!team || team.user_id !== user.id) return Response.json({ ok: false, error: '팀 없음' }, { status: 404 });
  const ws = Workspaces.get(team.workspace_id);
  if (!ws) return Response.json({ ok: false, error: '워크스페이스 없음' }, { status: 404 });
  const wsPath = ws.path;
  const workspace_id = ws.id;

  fs.mkdirSync(path.join(wsPath, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(wsPath, 'memory'), { recursive: true });

  // 기존 팀 에이전트 전체 삭제 (하네스 재설정 시 덮어쓰기)
  const existingAgents = Agents.listByTeam(org_id);
  for (const ea of existingAgents) {
    // 기존 에이전트 .md 파일도 삭제
    if (ea.command_name) {
      const mdPath = path.join(wsPath, '.claude', 'agents', `${ea.command_name}.md`);
      try { fs.unlinkSync(mdPath); } catch {}
    }
    Agents.delete(ea.id);
  }

  const created: string[] = [];

  for (const a of design.agents) {
    const id = randomUUID();
    const cmd = a.name.toLowerCase()
      .replace(/[^a-z0-9가-힣]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const org_level = a.is_lead ? 'team' : 'worker';
    const soul = `## 정체성\n당신은 ${a.name}입니다.\n\n## 핵심 역할\n${a.role}\n\n## 업무 처리 원칙\n- 맡은 업무에 집중하고 결과를 명확하게 전달합니다.\n- 문제 발생 시 즉시 보고하고 해결 방안을 제시합니다.\n\n## 보고 형식\n핵심 결과 → 진행 과정 → 다음 단계`;

    const mdContent = `---\nname: ${cmd}\ndescription: "${a.name} — ${a.role.slice(0, 80)}"\n---\n\n${soul}`;
    fs.writeFileSync(path.join(wsPath, '.claude', 'agents', `${cmd}.md`), mdContent, 'utf8');

    if (a.is_lead) {
      fs.writeFileSync(path.join(wsPath, 'SOUL.md'), soul, 'utf8');
    }

    Agents.create({
      id, workspace_id, team_id: org_id, part_id: null,
      parent_agent_id: null, org_level,
      is_lead: a.is_lead ? 1 : 0,
      name: a.name, emoji: a.emoji, color: a.color, soul,
      command_name: cmd, harness_pattern: a.harness_pattern,
      model: a.model || 'claude-sonnet-4-5', user_id: user.id,
    });

    // 백그라운드 소울 개선
    setImmediate(() => {
      try {
        const improvePrompt = `다음 에이전트의 SOUL.md를 더 구체적이고 실용적으로 개선해주세요.

에이전트: ${a.name}
역할: ${a.role}
패턴: ${a.harness_pattern}

현재 SOUL.md:
${soul}

개선된 SOUL.md만 출력 (## 정체성, ## 핵심 역할, ## 업무 처리 원칙, ## 협업 방식, ## 보고 형식 섹션 포함):`;
        const improved = execFileSync('claude', ['-p', improvePrompt], {
          cwd: wsPath, encoding: 'utf8', timeout: 60000, env: { ...process.env },
        }).trim();
        if (improved && improved.length > 50) {
          Agents.update(id, { soul: improved });
          if (a.is_lead) fs.writeFileSync(path.join(wsPath, 'SOUL.md'), improved, 'utf8');
          fs.writeFileSync(path.join(wsPath, '.claude', 'agents', `${cmd}.md`),
            `---\nname: ${cmd}\ndescription: "${a.name} — ${a.role.slice(0, 80)}"\n---\n\n${improved}`, 'utf8');
        }
      } catch {}
    });

    created.push(a.name);
  }

  // harness_prompt 저장
  if (task) db.prepare('UPDATE teams SET harness_prompt=? WHERE id=?').run(task, org_id);

  return Response.json({ ok: true, created });
}
