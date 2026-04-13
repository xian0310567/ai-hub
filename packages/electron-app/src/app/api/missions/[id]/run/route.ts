import { NextRequest } from 'next/server';
import { Missions, MissionJobs, McpServerConfigs } from '@/lib/db';
import { getSession, getVmSessionCookie } from '@/lib/auth';
import { readAllPersonalSecrets } from '@/lib/personal-vault';
import { scoreJob } from '@/lib/quality-scorer';
import { agentRun } from '@/lib/openclaw-executor';
import { ensureGatewayReady } from '@/lib/gateway-manager';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const VM_URL = process.env.VM_SERVER_URL || 'http://localhost:4000';

interface RoutingEntry {
  org_id: string; org_type: string; org_name: string;
  agent_id: string; agent_name: string; subtask: string;
  gate_type?: 'auto' | 'human';
  capability_tags?: string[];
  thinking?: string;            // openclaw_params에서 승격
  model?: string;               // openclaw_params에서 승격
  timeout_seconds?: number;     // openclaw_params에서 승격
  session_key?: string;         // openclaw_params에서 승격
  // 하위호환: 기존 DB 데이터에 있을 수 있는 필드 (무시됨)
  executor?: string;
  executor_reason?: string;
  openclaw_params?: {
    thinking?: string;
    model?: string;
    timeout_seconds?: number;
    session_key?: string;
  };
}

interface PreTask {
  type: 'openclaw_cron' | 'openclaw_session_init';
  params: Record<string, unknown>;
}

interface PostTask {
  type: 'openclaw_deliver' | 'notification' | 'schedule_register';
  params: Record<string, unknown>;
}

interface ExecutionPlan {
  pre_tasks: PreTask[];
  post_tasks: PostTask[];
}

interface Step {
  org_name: string; agent_name: string;
  status: 'queued' | 'waiting' | 'running' | 'done' | 'failed' | 'gate_pending';
  queue_position?: number; output?: string; error?: string; job_id?: string;
}

// vm-server API 헬퍼
async function vmGet(path: string, cookie: string) {
  const res = await fetch(`${VM_URL}${path}`, { headers: { Cookie: cookie } });
  return res.ok ? res.json() : null;
}
async function vmPatch(path: string, body: object, cookie: string) {
  await fetch(`${VM_URL}${path}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
}
async function vmPost(path: string, body: object, cookie: string) {
  const res = await fetch(`${VM_URL}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
  return res.ok ? res.json() : null;
}

// ── POST /api/missions/[id]/run ───────────────────────────────────────
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const mission = Missions.get(id);
  if (!mission || mission.user_id !== user.id) return Response.json({ ok: false, error: '미션 없음' }, { status: 404 });
  if (mission.status === 'running') return Response.json({ ok: false, error: '이미 실행 중' }, { status: 409 });

  const routing: RoutingEntry[] = JSON.parse(mission.routing || '[]');
  if (!routing.length) return Response.json({ ok: false, error: '라우팅 없음' }, { status: 400 });

  // execution_plan 파싱 (steps 메타에 저장된 실행 계획)
  let executionPlan: ExecutionPlan | null = null;
  try {
    const stepsMeta = JSON.parse(mission.steps || '{}');
    if (stepsMeta.execution_plan) executionPlan = stepsMeta.execution_plan;
  } catch {}

  const cookie = getVmSessionCookie(req);

  // Vault 시크릿을 환경변수로 수집 (personal + org/team)
  const vaultEnv = await collectVaultEnv(user.id, cookie);

  // MCP 서버 설정 파일 생성
  const mcpConfigPath = await buildMcpConfigFile(user.id, id);

  // 잡 + vm-server 태스크 생성
  const jobIds: string[] = [];
  const vmTaskIds: string[] = [];
  for (const r of routing) {
    const jobId = randomUUID();
    MissionJobs.create({ id: jobId, mission_id: id, agent_id: r.agent_id, agent_name: r.agent_name, org_name: r.org_name, subtask: r.subtask, gate_type: r.gate_type ?? 'auto' });
    jobIds.push(jobId);

    const task = await vmPost('/api/tasks', {
      agent_id: r.agent_id, agent_name: r.agent_name,
      title: r.subtask.slice(0, 80),
      description: `[미션] ${mission.task}`,
      trigger_type: 'interactive',
      preferred_host_id: null, // 로컬 실행이므로 null
    }, cookie);
    vmTaskIds.push(task?.id ?? '');
  }

  // 초기 step 상태 — SSE 스트림 생성 전에 DB를 'running'으로 갱신하여
  // 폴링과의 레이스 컨디션 방지 (폴링이 이전 상태를 읽는 문제)
  const steps: Step[] = routing.map((r, i) => {
    const queue = MissionJobs.queueForAgent(r.agent_id);
    const pos = queue.findIndex(j => j.id === jobIds[i]);
    return { org_name: r.org_name, agent_name: r.agent_name, status: pos > 0 ? 'waiting' : 'queued', queue_position: Math.max(0, pos) };
  });
  Missions.update(id, { status: 'running', steps: JSON.stringify(steps) });

  // SSE 스트리밍
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
      };

      send({ type: 'start', steps });

      // Gateway 준비 상태 확인 (미가용 시 CLI 폴백 자동 전환)
      const gatewayReady = await ensureGatewayReady();
      if (!gatewayReady) {
        send({ type: 'gateway_fallback', message: 'Gateway 미가용 — CLI 폴백 모드로 실행' });
      }

      // ── 1단계: pre_tasks (인프라 설정) ──
      if (executionPlan?.pre_tasks?.length) {
        for (const preTask of executionPlan.pre_tasks) {
          send({ type: 'pre_task', task_type: preTask.type, status: 'running' });
          try {
            await executePreTask(preTask, vaultEnv, { missionId: id, userId: user.id, missionTask: mission.task, routing: mission.routing || '[]', cookie });
            send({ type: 'pre_task', task_type: preTask.type, status: 'done' });
          } catch (err) {
            send({ type: 'pre_task', task_type: preTask.type, status: 'failed', error: err instanceof Error ? err.message : String(err) });
            // pre_task 실패 시 전체 미션 중단하지 않음 (폴백 가능)
          }
        }
      }

      // 협업 보드 생성 + 실시간 폴링
      const boardPath = buildMissionBoard(id, mission.task, routing);
      let boardPollStopped = false;
      let lastBoardContent = '';
      (async () => {
        while (!boardPollStopped) {
          await new Promise(res => setTimeout(res, 4000));
          try {
            const content = fs.readFileSync(boardPath, 'utf8');
            if (content !== lastBoardContent) { lastBoardContent = content; send({ type: 'board_update', content }); }
          } catch {}
        }
      })();

      const results: { org_name: string; agent_name: string; output: string }[] = [];

      await Promise.allSettled(routing.map(async (r, idx) => {
        const jobId = jobIds[idx];
        const vmTaskId = vmTaskIds[idx];

        // 큐 대기
        await waitForTurn(r.agent_id, jobId, (pos) => {
          steps[idx] = { ...steps[idx], status: 'waiting', queue_position: pos };
          Missions.update(id, { steps: JSON.stringify(steps) });
          send({ type: 'step', idx, status: 'waiting', org_name: r.org_name, agent_name: r.agent_name, queue_position: pos });
        });

        // Human Gate: 인간 승인을 기다린 후 실행
        if (r.gate_type === 'human') {
          MissionJobs.setPendingGate(jobId);
          steps[idx] = { ...steps[idx], status: 'gate_pending', queue_position: 0, job_id: jobId };
          Missions.update(id, { steps: JSON.stringify(steps) });
          send({ type: 'step', idx, status: 'gate_pending', org_name: r.org_name, agent_name: r.agent_name, job_id: jobId });
          await waitForApproval(jobId);
        }

        MissionJobs.start(jobId);
        if (vmTaskId) await vmPatch('/api/tasks', { id: vmTaskId, status: 'running' }, cookie);
        steps[idx] = { ...steps[idx], status: 'running', queue_position: 0 };
        Missions.update(id, { steps: JSON.stringify(steps) });
        send({ type: 'step', idx, status: 'running', org_name: r.org_name, agent_name: r.agent_name });

        try {
          // vm-server에서 에이전트 정보 가져오기
          const agent = await vmGet(`/api/agents/${r.agent_id}`, cookie);

          // 워크스페이스 경로 결정
          let wsPath = process.cwd();
          if (agent?.workspace_id) {
            try {
              const ws = await vmGet(`/api/workspaces/${agent.workspace_id}`, cookie);
              const realPath = ws?.path?.trim();
              if (realPath && fs.existsSync(realPath)) {
                wsPath = realPath;
              } else {
                const dataDir = process.env.DATA_DIR || path.join(process.cwd(), '.data');
                wsPath = path.join(dataDir, 'workspaces', agent.workspace_id);
                fs.mkdirSync(wsPath, { recursive: true });
              }
            } catch {
              const dataDir = process.env.DATA_DIR || path.join(process.cwd(), '.data');
              wsPath = path.join(dataDir, 'workspaces', agent.workspace_id);
              fs.mkdirSync(wsPath, { recursive: true });
            }
          }

          // 이미지 경로 수집
          const imagePaths: string[] = [];
          if (mission.images) {
            try { JSON.parse(mission.images).forEach((img: { path: string }) => { if (img.path) imagePaths.push(img.path); }); } catch {}
          }

          // 하위호환: openclaw_params에서 승격된 필드 우선 사용
          const thinking = r.thinking || r.openclaw_params?.thinking;
          const model = r.model || r.openclaw_params?.model || agent?.model;
          const timeoutSeconds = r.timeout_seconds || r.openclaw_params?.timeout_seconds || 300;
          const sessionKey = r.session_key || r.openclaw_params?.session_key;

          // 프롬프트 조립
          const routingCtx = routing.length > 1
            ? `\n## 전체 실행 계획\n이 미션은 다음 조직들이 동시에 진행합니다:\n${routing.map((re, i) => `  ${i + 1}. [${re.org_name}] ${re.agent_name}: ${re.subtask.split('\n')[0].slice(0, 100)}`).join('\n')}\n\n당신의 역할: **${r.org_name} (${r.agent_name})**\n`
            : '';
          const boardCtx = boardPath
            ? `\n## 협업 보드\n모든 에이전트가 공유하는 소통 공간: ${boardPath}\n\n1. 작업 시작 전 보드를 읽어 다른 에이전트의 진행 상황을 파악하세요\n2. 의존성, 이슈, 중요 발견 사항을 보드에 기록하세요\n3. 작업 완료 후 보드 하단에 결과를 추가하세요\n`
            : '';
          const prompt = `## 미션\n전체 미션: ${mission.task}${imagePaths.length ? `\n\n**참고: ${imagePaths.length}개 이미지 첨부됨**` : ''}\n${routingCtx}${boardCtx}\n## 배정된 업무\n${r.subtask}\n\n## 지시사항\nRead, Edit, Write, Bash 도구를 사용해 작업을 직접 완료하세요.\n완료 후 "## 완료된 작업" 섹션에 수행한 내용을 요약하세요.\n\n지금 바로 시작하세요:`;

          // 통합 실행 - 전부 agentRun()을 통해 OpenClaw Gateway 경유
          const result = await agentRun({
            message: prompt,
            agent: sessionKey || r.agent_id,
            thinking,
            model,
            timeout: timeoutSeconds,
            sessionId: sessionKey,
            cwd: wsPath,
            allowTools: true,
            imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
            systemPrompt: agent?.soul || undefined,
            mcpConfigPath: mcpConfigPath || undefined,
            extraEnv: vaultEnv,
          });

          if (!result.ok) throw new Error(result.error || '에이전트 실행 실패');
          const output = result.output || '';

          // 증거 없는 완료 불인정
          if (!output || output.trim().length < 50) {
            throw new Error('완료 증거 미제출 — 결과물이 너무 짧거나 비어 있음');
          }

          MissionJobs.finish(jobId, output);
          scoreJob(jobId, user.id); // fire-and-forget 품질 채점
          if (vmTaskId) await vmPatch('/api/tasks', { id: vmTaskId, status: 'completed', result: output }, cookie);
          steps[idx] = { ...steps[idx], status: 'done', output };
          Missions.update(id, { steps: JSON.stringify(steps) });
          send({ type: 'step', idx, status: 'done', org_name: r.org_name, agent_name: r.agent_name, output });
          results.push({ org_name: r.org_name, agent_name: r.agent_name, output });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          MissionJobs.fail(jobId, msg);
          if (vmTaskId) await vmPatch('/api/tasks', { id: vmTaskId, status: 'failed', result: msg }, cookie);
          steps[idx] = { ...steps[idx], status: 'failed', error: msg };
          Missions.update(id, { steps: JSON.stringify(steps) });
          send({ type: 'step', idx, status: 'failed', org_name: r.org_name, agent_name: r.agent_name, error: msg });
          results.push({ org_name: r.org_name, agent_name: r.agent_name, output: `[실패: ${msg}]` });
        }
      }));
      boardPollStopped = true;

      // ── 3단계: post_tasks (결과 전송, 알림) ──
      if (executionPlan?.post_tasks?.length) {
        for (const postTask of executionPlan.post_tasks) {
          send({ type: 'post_task', task_type: postTask.type, status: 'running' });
          try {
            await executePostTask(postTask, results);
            send({ type: 'post_task', task_type: postTask.type, status: 'done' });
          } catch (err) {
            send({ type: 'post_task', task_type: postTask.type, status: 'failed', error: err instanceof Error ? err.message : String(err) });
          }
        }
      }

      // 스텝 결과가 전부 실패인 경우에도 통합 문서 생성 시도
      const allFailed = results.every(r => r.output.startsWith('[실패:'));
      console.log(`[run] mission ${id}: steps done (${results.length}개, 전부실패=${allFailed}), consolidating...`);

      send({ type: 'consolidating' });
      try {
        const finalDoc = await consolidateResults(mission.task, results, id);
        Missions.update(id, { status: 'done', final_doc: finalDoc, steps: JSON.stringify(steps) });
        send({ type: 'done', final_doc: finalDoc });
        console.log(`[run] mission ${id}: done`);
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error(`[run] mission ${id}: consolidation failed:`, errMsg);
        Missions.update(id, { status: 'failed', error: `통합 문서 생성 실패: ${errMsg}`, steps: JSON.stringify(steps) });
        send({ type: 'error', error: `통합 문서 생성 실패: ${errMsg}` });
      } finally {
        // MCP 임시 설정 파일 정리
        if (mcpConfigPath) { try { fs.unlinkSync(mcpConfigPath); } catch {} }
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  });
  } catch (err) {
    console.error('[POST /api/missions/:id/run] 오류:', err instanceof Error ? err.message : err);
    return Response.json({ ok: false, error: '미션 실행 준비 중 오류가 발생했습니다' }, { status: 500 });
  }
}

// ── Human Gate 승인 대기 ──────────────────────────────────────────────
async function waitForApproval(jobId: string) {
  const MAX_WAIT = 30 * 60 * 1000; // 30분
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT) {
    const job = MissionJobs.get(jobId);
    if (job?.gate_status === 'approved') return;
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Human Gate 승인 대기 시간 초과 (30분)');
}

// ── 큐 대기 ────────────────────────────────────────────────────────────
async function waitForTurn(agentId: string, jobId: string, onWait: (pos: number) => void) {
  const MAX_WAIT = 600_000;
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT) {
    const running = MissionJobs.runningForAgent(agentId);
    if (!running) {
      const next = MissionJobs.nextQueued(agentId);
      if (!next || next.id === jobId) return;
    }
    const queue = MissionJobs.queueForAgent(agentId);
    onWait(queue.findIndex(j => j.id === jobId));
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('큐 대기 시간 초과 (10분)');
}

// ── Vault 환경변수 수집 (personal_meta + org/team) ───────────────────
async function collectVaultEnv(userId: string, cookie: string): Promise<Record<string, string>> {
  try {
    const res = await fetch(`${VM_URL}/api/vaults`, { headers: { Cookie: cookie } });
    if (!res.ok) return {};
    const vaults = await res.json() as { id: string; scope: string }[];
    if (!vaults.length) return {};

    const envVars: Record<string, string> = {};
    await Promise.all(vaults.map(async vault => {
      try {
        const secretsRes = await fetch(`${VM_URL}/api/vaults/${vault.id}/secrets`, { headers: { Cookie: cookie } });
        if (!secretsRes.ok) return;
        const secrets = await secretsRes.json() as { key_name: string }[];
        const keyNames = secrets.map(s => s.key_name);
        if (!keyNames.length) return;

        if (vault.scope === 'personal_meta') {
          // 실제 값은 로컬 키체인에서 조회
          const values = await readAllPersonalSecrets(userId, vault.id, keyNames);
          Object.assign(envVars, values);
        } else {
          // org/team vault: lease 엔드포인트로 서버에서 복호화 값 수신
          const leaseRes = await fetch(`${VM_URL}/api/vaults/${vault.id}/lease`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ key_names: keyNames, task_id: null }),
          });
          if (!leaseRes.ok) return;
          const { secrets: leased } = await leaseRes.json() as { secrets: Record<string, string> };
          Object.assign(envVars, leased);
        }
      } catch { /* vault 개별 실패는 무시 */ }
    }));

    return envVars;
  } catch {
    return {};
  }
}


// ── MCP 설정 파일 생성 ─────────────────────────────────────────────────
async function buildMcpConfigFile(userId: string, missionId: string): Promise<string | null> {
  try {
    const configs = McpServerConfigs.listEnabled(userId);
    if (!configs.length) return null;
    const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
    for (const c of configs) {
      const args = JSON.parse(c.args || '[]');
      const env  = JSON.parse(c.env_json || '{}');
      mcpServers[c.name] = { command: c.command, args, ...(Object.keys(env).length ? { env } : {}) };
    }
    const tmpPath = path.join('/tmp', `mcp-config-${missionId}.json`);
    fs.writeFileSync(tmpPath, JSON.stringify({ mcpServers }, null, 2));
    return tmpPath;
  } catch {
    return null;
  }
}

// ── 협업 보드 생성 ──────────────────────────────────────────────────────
function buildMissionBoard(missionId: string, task: string, routingEntries: RoutingEntry[]): string {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), '.data');
  const boardsDir = path.join(dataDir, 'boards');
  fs.mkdirSync(boardsDir, { recursive: true });
  const boardPath = path.join(boardsDir, `mission-${missionId}.md`);
  const plan = routingEntries.map((r, i) =>
    `| ${i + 1} | ${r.org_name} | ${r.agent_name} | ${r.subtask.replace(/\n+/g, ' ').slice(0, 100)} |`
  ).join('\n');
  const content = `# 미션 협업 보드\n\n## 미션 목표\n${task}\n\n## 전체 실행 계획\n| # | 조직 | 에이전트 | 담당 업무 요약 |\n|---|------|---------|---------------|\n${plan}\n\n---\n> 이 보드는 모든 에이전트가 공유하는 소통 공간입니다.\n> 작업 시작 시 이 파일을 읽고, 완료 후 아래에 결과를 기록해 주세요.\n\n## 에이전트 소통 기록\n\n`;
  fs.writeFileSync(boardPath, content, 'utf8');
  return boardPath;
}

// ── 최종 통합 문서 ─────────────────────────────────────────────────────
async function consolidateResults(task: string, results: { org_name: string; agent_name: string; output: string }[], missionId: string): Promise<string> {
  const mission = Missions.get(missionId);
  const imagePaths: string[] = [];
  if (mission?.images) {
    try { JSON.parse(mission.images).forEach((img: { path: string }) => { if (img.path) imagePaths.push(img.path); }); } catch {}
  }

  const resultBlock = results.map((r, i) => `### ${i + 1}. ${r.org_name} (${r.agent_name})\n${r.output}`).join('\n\n---\n\n');
  const prompt = `당신은 AI 조직의 최종 보고서 작성자입니다.\n\n## 원래 미션\n${task}\n\n## 각 조직의 완료 작업\n${resultBlock}\n\n위 결과를 종합한 최종 완료 보고서를 작성하세요.\n"다음 단계", "향후 제언" 같은 미래 계획은 포함하지 마세요.\n\n# 미션 완료 보고서\n형식으로 작성하고, 결과물만 출력하세요:`;

  const result = await agentRun({
    message: prompt,
    imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
    timeout: 300,
  });

  if (!result.ok) throw new Error(result.error || '통합 문서 생성 실패');
  return result.output || '';
}


// ── Pre-task 실행 ─────────────────────────────────────────────────────
async function executePreTask(
  task: PreTask,
  vaultEnv: Record<string, string>,
  ctx: { missionId: string; userId: string; missionTask: string; routing: string; cookie: string },
): Promise<void> {
  switch (task.type) {
    case 'openclaw_cron': {
      const p = task.params as Record<string, string>;
      const cronExpr = p.cron || '';
      if (!cronExpr) throw new Error('cron 표현식이 없습니다');
      const schedRes = await vmPost('/api/schedules', {
        name: p.name || '미션 크론',
        cron_expr: cronExpr,
        payload: JSON.stringify({ task: p.message || ctx.missionTask, description: ctx.missionTask }),
      }, ctx.cookie);
      if (!schedRes) {
        throw new Error('vm-server 스케줄 등록에 실패했습니다');
      }
      break;
    }
    case 'openclaw_session_init': {
      break;
    }
  }
}

// ── Post-task 실행 ────────────────────────────────────────────────────
async function executePostTask(task: PostTask, results: { org_name: string; agent_name: string; output: string }[]): Promise<void> {
  switch (task.type) {
    case 'openclaw_deliver': {
      const p = task.params as Record<string, string>;
      const summary = results.map(r => `[${r.org_name}] ${r.output.slice(0, 200)}`).join('\n');
      const msg = p.message || summary;
      const result = await agentRun({
        message: `다음 내용을 ${p.channel || 'slack'}의 ${p.to || '기본 채널'}에 전송하세요:\n\n${msg}`,
        deliver: true,
        channel: p.channel,
        to: p.to,
      });
      if (!result.ok) throw new Error(`채널 전송 실패: ${result.error}`);
      break;
    }
    case 'notification': {
      // 알림은 현재 로컬 알림 생성으로 처리 (향후 확장)
      break;
    }
    case 'schedule_register': {
      // 스케줄 등록은 Phase 5에서 처리
      break;
    }
  }
}
