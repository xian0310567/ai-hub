import { NextRequest } from 'next/server';
import { getSession, getVmSessionCookie } from '@/lib/auth';
import { CLAUDE_CLI, CLAUDE_ENV, claudeSpawnError } from '@/lib/claude-cli';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const VM_URL = process.env.VM_SERVER_URL || 'http://localhost:4000';

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

// ── vm-server 헬퍼 ────────────────────────────────────────────────────
async function vmGet<T>(endpoint: string, cookie: string): Promise<T | null> {
  try {
    const res = await fetch(`${VM_URL}${endpoint}`, {
      headers: { Cookie: cookie },
    });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch { return null; }
}

async function vmPost<T>(endpoint: string, cookie: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${VM_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch { return null; }
}

async function vmPatch(endpoint: string, cookie: string, body: unknown): Promise<void> {
  try {
    await fetch(`${VM_URL}${endpoint}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    });
  } catch {}
}

async function vmDelete(endpoint: string, cookie: string, body: unknown): Promise<void> {
  try {
    await fetch(`${VM_URL}${endpoint}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    });
  } catch {}
}

interface VmWorkspace { id: string; name: string; path: string; division_id?: string }
interface VmDivision  { id: string; name: string; ws_path: string }
interface VmTeam      { id: string; name: string; workspace_id: string }
interface VmAgent     { id: string; command_name?: string; org_level?: string; is_lead: number }

/** 하네스 변경 후 OpenClaw 워크스페이스 동기화를 트리거한다 (비동기/백그라운드). */
function triggerOpenClawSync(cookie: string): void {
  vmPost('/api/openclaw/sync', cookie, {}).catch(() => {
    // 동기화 실패는 무시 — 에이전트 생성 자체는 이미 성공
  });
}

async function getWsPath(
  orgId: string,
  orgType: 'division' | 'department' | 'team',
  cookie: string,
): Promise<{ wsPath: string; workspaceId?: string } | null> {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), '.data');
  const fallback = (id: string) => {
    const p = path.join(dataDir, 'workspaces', id);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };

  const ensureDir = (p: string) => { fs.mkdirSync(p, { recursive: true }); return p; };

  if (orgType === 'division') {
    const div = await vmGet<VmDivision>(`/api/divisions/${orgId}`, cookie);
    if (!div) return null;
    const wsPath = ensureDir(div.ws_path?.trim() || fallback(orgId));
    return { wsPath };
  }
  if (orgType === 'department') {
    const ws = await vmGet<VmWorkspace>(`/api/workspaces/${orgId}`, cookie);
    if (!ws) return null;
    const wsPath = ensureDir(ws.path?.trim() || fallback(orgId));
    return { wsPath, workspaceId: ws.id };
  }
  // team
  const team = await vmGet<VmTeam>(`/api/teams/${orgId}`, cookie);
  if (!team) return null;
  const ws = await vmGet<VmWorkspace>(`/api/workspaces/${team.workspace_id}`, cookie);
  const wsPath = ensureDir(ws?.path?.trim() || fallback(orgId));
  return { wsPath, workspaceId: ws?.id ?? team.workspace_id };
}

// ── POST /api/harness — 설계 요청 ────────────────────────────────────
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

  const cookie = getVmSessionCookie(req);
  const loc = await getWsPath(org_id, org_type, cookie);
  if (!loc) return Response.json({ ok: false, error: `조직을 찾을 수 없습니다 (id: ${org_id})` }, { status: 404 });
  const { wsPath } = loc;

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
      const result = execFileSync(CLAUDE_CLI, ['-p', prompt], {
        cwd: wsPath, encoding: 'utf8', timeout: 90000, env: CLAUDE_ENV,
      });
      const cleaned = result.trim().replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'');
      const design = JSON.parse(cleaned);
      return Response.json({ ok: true, design, mode: 'leader' });
    } catch (e: any) {
      return Response.json({ ok: false, error: `설계 실패: ${claudeSpawnError(e)}` }, { status: 500 });
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
    const result = execFileSync(CLAUDE_CLI, ['-p', prompt], {
      cwd: wsPath, encoding: 'utf8', timeout: 90000, env: CLAUDE_ENV,
    });
    const cleaned = result.trim().replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'');
    const design = JSON.parse(cleaned);
    return Response.json({ ok: true, design, mode: 'team' });
  } catch (e: any) {
    return Response.json({ ok: false, error: `설계 실패: ${claudeSpawnError(e)}` }, { status: 500 });
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

  const cookie = getVmSessionCookie(req);
  const loc = await getWsPath(org_id, org_type, cookie);
  if (!loc) return Response.json({ ok: false, error: `조직을 찾을 수 없습니다 (id: ${org_id})` }, { status: 404 });
  const { wsPath, workspaceId } = loc;

  // ── 부문/실: 리더 1명만 생성/업데이트 ──
  if (mode === 'leader') {
    const soul = design.soul || '';
    const name = design.name || `${org_name}장`;
    const cmd = name.toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

    fs.mkdirSync(path.join(wsPath, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(wsPath, 'SOUL.md'), soul, 'utf8');
    fs.writeFileSync(path.join(wsPath, '.claude', 'agents', `${cmd}.md`),
      `---\nname: ${cmd}\ndescription: "${name}"\n---\n\n${soul}`, 'utf8');

    // 기존 리더 에이전트 조회 (division/department 모두 org_id를 workspace_id에 저장)
    const existingAgents = await vmGet<VmAgent[]>(`/api/agents?workspace_id=${org_id}`, cookie) ?? [];
    const existing = existingAgents.find(a => a.org_level === org_type);

    if (existing) {
      await vmPatch('/api/agents', cookie, {
        id: existing.id, name, emoji: design.emoji, color: design.color, soul, command_name: cmd,
      });
    } else {
      await vmPost('/api/agents', cookie, {
        workspace_id: org_id, team_id: null, part_id: null, parent_agent_id: null,
        org_level: org_type, is_lead: true,
        name, emoji: design.emoji || '👔', color: design.color || '#7c3aed',
        soul, command_name: cmd, harness_pattern: 'orchestrator',
        model: 'claude-opus-4-5',
      });
    }

    // harness_prompt 저장
    if (task) {
      const patchEp = org_type === 'division' ? '/api/divisions' : '/api/workspaces';
      await vmPatch(patchEp, cookie, { id: org_id, harness_prompt: task });
    }

    // OpenClaw 워크스페이스 동기화 (백그라운드)
    triggerOpenClawSync(cookie);

    return Response.json({ ok: true, created: [name] });
  }

  // ── 팀: 멀티 에이전트 생성 ──
  fs.mkdirSync(path.join(wsPath, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(wsPath, 'memory'), { recursive: true });

  // 기존 팀 에이전트 전체 삭제 (하네스 재설정 시 덮어쓰기)
  const existingAgents = await vmGet<VmAgent[]>(`/api/agents?team_id=${org_id}`, cookie) ?? [];
  for (const ea of existingAgents) {
    if (ea.command_name) {
      const mdPath = path.join(wsPath, '.claude', 'agents', `${ea.command_name}.md`);
      try { fs.unlinkSync(mdPath); } catch {}
    }
    await vmDelete('/api/agents', cookie, { id: ea.id });
  }

  const wsId = workspaceId ?? org_id;
  const created: string[] = [];

  for (const a of design.agents) {
    const cmd = a.name.toLowerCase()
      .replace(/[^a-z0-9가-힣]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const orgLevel = a.is_lead ? 'team' : 'worker';
    const soul = `## 정체성\n당신은 ${a.name}입니다.\n\n## 핵심 역할\n${a.role}\n\n## 업무 처리 원칙\n- 맡은 업무에 집중하고 결과를 명확하게 전달합니다.\n- 문제 발생 시 즉시 보고하고 해결 방안을 제시합니다.\n\n## 보고 형식\n핵심 결과 → 진행 과정 → 다음 단계`;

    const mdContent = `---\nname: ${cmd}\ndescription: "${a.name} — ${a.role.slice(0, 80)}"\n---\n\n${soul}`;
    fs.writeFileSync(path.join(wsPath, '.claude', 'agents', `${cmd}.md`), mdContent, 'utf8');

    if (a.is_lead) {
      fs.writeFileSync(path.join(wsPath, 'SOUL.md'), soul, 'utf8');
    }

    const newAgent = await vmPost<{ id: string }>('/api/agents', cookie, {
      workspace_id: wsId, team_id: org_id, part_id: null,
      parent_agent_id: null, org_level: orgLevel,
      is_lead: a.is_lead,
      name: a.name, emoji: a.emoji, color: a.color, soul,
      command_name: cmd, harness_pattern: a.harness_pattern,
      model: a.model || 'claude-sonnet-4-5',
    });

    // 백그라운드 소울 개선
    if (newAgent?.id) {
      const agentId = newAgent.id;
      setImmediate(() => {
        try {
          const improvePrompt = `다음 에이전트의 SOUL.md를 더 구체적이고 실용적으로 개선해주세요.

에이전트: ${a.name}
역할: ${a.role}
패턴: ${a.harness_pattern}

현재 SOUL.md:
${soul}

개선된 SOUL.md만 출력 (## 정체성, ## 핵심 역할, ## 업무 처리 원칙, ## 협업 방식, ## 보고 형식 섹션 포함):`;
          const improved = execFileSync(CLAUDE_CLI, ['-p', improvePrompt], {
            cwd: wsPath, encoding: 'utf8', timeout: 60000, env: CLAUDE_ENV,
          }).trim();
          if (improved && improved.length > 50) {
            vmPatch('/api/agents', cookie, { id: agentId, soul: improved });
            if (a.is_lead) fs.writeFileSync(path.join(wsPath, 'SOUL.md'), improved, 'utf8');
            fs.writeFileSync(path.join(wsPath, '.claude', 'agents', `${cmd}.md`),
              `---\nname: ${cmd}\ndescription: "${a.name} — ${a.role.slice(0, 80)}"\n---\n\n${improved}`, 'utf8');
          }
        } catch {}
      });
    }

    created.push(a.name);
  }

  // harness_prompt 저장
  if (task) await vmPatch('/api/teams', cookie, { id: org_id, harness_prompt: task });

  // OpenClaw 워크스페이스 동기화 (백그라운드)
  triggerOpenClawSync(cookie);

  return Response.json({ ok: true, created });
}
