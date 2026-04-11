/**
 * POST /api/missions/[id]/resume
 * 실패한 미션을 이어받아 실행 — 이미 'done' 상태인 잡은 건너뛰고
 * 실패했거나 아직 실행 안 된 라우팅 항목만 다시 돌린다.
 */
import { NextRequest } from 'next/server';
import { Missions, MissionJobs, McpServerConfigs } from '@/lib/db';
import { getSession, getVmSessionCookie } from '@/lib/auth';
import { readAllPersonalSecrets } from '@/lib/personal-vault';
import { scoreJob } from '@/lib/quality-scorer';
import { CLAUDE_CLI, CLAUDE_ENV } from '@/lib/claude-cli';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);
const VM_URL = process.env.VM_SERVER_URL || 'http://localhost:4000';

interface RoutingEntry {
  org_id: string; org_type: string; org_name: string;
  agent_id: string; agent_name: string; subtask: string;
  gate_type?: 'auto' | 'human';
}
interface Step {
  org_name: string; agent_name: string;
  status: 'queued' | 'waiting' | 'running' | 'done' | 'failed' | 'gate_pending';
  queue_position?: number; output?: string; error?: string; job_id?: string;
}

// ── vm-server 헬퍼 ────────────────────────────────────────────────────
async function vmGet(endpoint: string, cookie: string) {
  const res = await fetch(`${VM_URL}${endpoint}`, { headers: { Cookie: cookie } });
  return res.ok ? res.json() : null;
}
async function vmPatch(endpoint: string, body: object, cookie: string) {
  await fetch(`${VM_URL}${endpoint}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
}
async function vmPost(endpoint: string, body: object, cookie: string) {
  const res = await fetch(`${VM_URL}${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
  return res.ok ? res.json() : null;
}

// ── Vault 시크릿 수집 ──────────────────────────────────────────────────
async function collectVaultEnv(userId: string, cookie: string): Promise<Record<string, string>> {
  try {
    const res = await fetch(`${VM_URL}/api/vaults`, { headers: { Cookie: cookie } });
    if (!res.ok) return {};
    const vaults = await res.json() as { id: string; scope: string }[];
    const envVars: Record<string, string> = {};
    await Promise.all(vaults.map(async vault => {
      try {
        const secretsRes = await fetch(`${VM_URL}/api/vaults/${vault.id}/secrets`, { headers: { Cookie: cookie } });
        if (!secretsRes.ok) return;
        const secrets = await secretsRes.json() as { key_name: string }[];
        const keyNames = secrets.map(s => s.key_name);
        if (!keyNames.length) return;
        if (vault.scope === 'personal_meta') {
          const values = await readAllPersonalSecrets(userId, vault.id, keyNames);
          Object.assign(envVars, values);
        } else {
          const leaseRes = await fetch(`${VM_URL}/api/vaults/${vault.id}/lease`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ key_names: keyNames, task_id: null }),
          });
          if (!leaseRes.ok) return;
          const { secrets: leased } = await leaseRes.json() as { secrets: Record<string, string> };
          Object.assign(envVars, leased);
        }
      } catch {}
    }));
    return envVars;
  } catch { return {}; }
}

// ── Claude CLI 호출 ────────────────────────────────────────────────────
async function callClaude(prompt: string, cwd: string, modelArgs: string[] = [], imagePaths: string[] = [], extraEnv: Record<string, string> = {}): Promise<string> {
  let lastErr: Error | null = null;
  for (let i = 0; i < 2; i++) {
    try {
      const { stdout } = await execFileAsync(
        CLAUDE_CLI,
        ['-p', prompt, '--allowedTools', 'Edit,Write,Read,Bash', '--dangerously-skip-permissions', ...modelArgs, ...imagePaths],
        { cwd, encoding: 'utf8', timeout: 300_000, env: { ...CLAUDE_ENV, ...extraEnv }, maxBuffer: 10 * 1024 * 1024 },
      );
      return stdout.trim();
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const err = e as NodeJS.ErrnoException & { killed?: boolean; stdout?: string };
      if (err.killed || err.code === 'ETIMEDOUT') { await new Promise(r => setTimeout(r, 3000)); continue; }
      if (err.code === 'ERR_CHILD_PROCESS_STDOUT_MAX_BUFFER_SIZE' && err.stdout && (err.stdout as string).trim().length > 50)
        return (err.stdout as string).trim();
      throw e;
    }
  }
  throw lastErr;
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

// ── 협업 보드 생성/재사용 ──────────────────────────────────────────────
function ensureMissionBoard(missionId: string, task: string, routingEntries: RoutingEntry[]): string {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), '.data');
  const boardsDir = path.join(dataDir, 'boards');
  fs.mkdirSync(boardsDir, { recursive: true });
  const boardPath = path.join(boardsDir, `mission-${missionId}.md`);
  if (!fs.existsSync(boardPath)) {
    const plan = routingEntries.map((r, i) =>
      `| ${i + 1} | ${r.org_name} | ${r.agent_name} | ${r.subtask.replace(/\n+/g, ' ').slice(0, 100)} |`
    ).join('\n');
    const content = `# 미션 협업 보드\n\n## 미션 목표\n${task}\n\n## 전체 실행 계획\n| # | 조직 | 에이전트 | 담당 업무 요약 |\n|---|------|---------|---------------|\n${plan}\n\n---\n> 이 보드는 모든 에이전트가 공유하는 소통 공간입니다.\n> 작업 시작 시 이 파일을 읽고, 완료 후 아래에 결과를 기록해 주세요.\n\n## 에이전트 소통 기록\n\n`;
    fs.writeFileSync(boardPath, content, 'utf8');
  }
  return boardPath;
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
    const tmpPath = path.join('/tmp', `mcp-config-resume-${missionId}.json`);
    fs.writeFileSync(tmpPath, JSON.stringify({ mcpServers }, null, 2));
    return tmpPath;
  } catch { return null; }
}

// ── Human Gate 승인 대기 ───────────────────────────────────────────────
async function waitForApproval(jobId: string) {
  const MAX_WAIT = 30 * 60 * 1000;
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT) {
    const job = MissionJobs.get(jobId);
    if (job?.gate_status === 'approved') return;
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Human Gate 승인 대기 시간 초과 (30분)');
}

// ── POST /api/missions/[id]/resume ────────────────────────────────────
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const mission = Missions.get(id);
  if (!mission || mission.user_id !== user.id)
    return Response.json({ ok: false, error: '미션 없음' }, { status: 404 });

  if (!['failed', 'routed', 'done'].includes(mission.status))
    return Response.json({ ok: false, error: `재개 불가 상태: ${mission.status}` }, { status: 409 });

  const routing: RoutingEntry[] = JSON.parse(mission.routing || '[]');
  if (!routing.length) return Response.json({ ok: false, error: '라우팅 없음' }, { status: 400 });

  const cookie = getVmSessionCookie(req);
  const vaultEnv = await collectVaultEnv(user.id, cookie);

  // MCP 설정 파일 생성
  const mcpConfigPath = await buildMcpConfigFile(user.id, id);

  // 기존 잡 조회 — routing 순서(agent_id+subtask)로 매칭해 인덱스 정렬 문제 방지
  const allJobs = MissionJobs.listByMission(id);
  const prevSteps: Step[] = (() => {
    try {
      const parsed = JSON.parse(mission.steps || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  })();

  // routing 항목별로 가장 최근 'done' 잡을 찾아 매칭
  const latestDoneByKey = new Map<string, typeof allJobs[0]>();
  for (const job of allJobs) {
    if (job.status === 'done') {
      const key = `${job.agent_id}::${job.subtask}`;
      latestDoneByKey.set(key, job); // 마지막(최신) done 잡 유지
    }
  }

  // 재개 대상 routing 항목과 새 jobId 결정
  const resumeRouting: RoutingEntry[] = [];
  const newJobIds: string[] = [];
  const steps: Step[] = routing.map((r, i) => {
    const key = `${r.agent_id}::${r.subtask}`;
    const doneJob = latestDoneByKey.get(key);
    if (doneJob) {
      // 완료 항목은 그대로 유지
      return prevSteps[i] ?? { org_name: r.org_name, agent_name: r.agent_name, status: 'done', output: doneJob.result };
    }
    // 재실행 대상
    const jobId = randomUUID();
    MissionJobs.create({ id: jobId, mission_id: id, agent_id: r.agent_id, agent_name: r.agent_name, org_name: r.org_name, subtask: r.subtask, gate_type: r.gate_type ?? 'auto' });
    resumeRouting.push(r);
    newJobIds.push(jobId);
    return { org_name: r.org_name, agent_name: r.agent_name, status: 'queued' as const };
  });

  if (!resumeRouting.length) {
    return Response.json({ ok: false, error: '재개할 잡이 없습니다 (모두 완료됨)' }, { status: 409 });
  }

  // vm-server 태스크 생성
  const vmTaskIds: string[] = [];
  for (const r of resumeRouting) {
    const task = await vmPost('/api/tasks', {
      agent_id: r.agent_id, agent_name: r.agent_name,
      title: r.subtask.slice(0, 80),
      description: `[미션재개] ${mission.task}`,
      trigger_type: 'interactive',
      preferred_host_id: null,
    }, cookie);
    vmTaskIds.push(task?.id ?? '');
  }

  Missions.update(id, { status: 'running', steps: JSON.stringify(steps) });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
      };

      send({ type: 'start', steps });

      // 협업 보드 생성/재사용 + 실시간 폴링
      const boardPath = ensureMissionBoard(id, mission.task, routing);
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

      // 기존 done 잡 결과 수집
      for (const re of routing) {
        const key = `${re.agent_id}::${re.subtask}`;
        const doneJob = latestDoneByKey.get(key);
        if (doneJob) results.push({ org_name: re.org_name, agent_name: re.agent_name, output: doneJob.result });
      }

      await Promise.allSettled(resumeRouting.map(async (r, resumeIdx) => {
        const jobId = newJobIds[resumeIdx];
        const vmTaskId = vmTaskIds[resumeIdx];
        // 전체 routing에서 이 항목의 원래 idx 찾기
        const idx = routing.findIndex(orig => orig.agent_id === r.agent_id && orig.subtask === r.subtask);

        await waitForTurn(r.agent_id, jobId, (pos) => {
          steps[idx] = { ...steps[idx], status: 'waiting', queue_position: pos };
          Missions.update(id, { steps: JSON.stringify(steps) });
          send({ type: 'step', idx, status: 'waiting', org_name: r.org_name, agent_name: r.agent_name, queue_position: pos });
        });

        // Human Gate
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
          const agent = await vmGet(`/api/agents/${r.agent_id}`, cookie);
          let wsPath = process.cwd();
          if (agent?.workspace_id) {
            try {
              const ws = await vmGet(`/api/workspaces/${agent.workspace_id}`, cookie);
              const realPath = ws?.path?.trim();
              if (realPath && fs.existsSync(realPath)) { wsPath = realPath; }
              else {
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
          const imagePaths: string[] = [];
          if (mission.images) {
            try { JSON.parse(mission.images).forEach((img: { path: string }) => { if (img.path) imagePaths.push(img.path); }); } catch {}
          }
          const modelArgs = agent?.model ? ['--model', agent.model] : [];
          const mcpArgs = mcpConfigPath ? ['--mcp-config', mcpConfigPath] : [];

          const routingCtx = routing.length > 1
            ? `\n## 전체 실행 계획\n이 미션은 다음 조직들이 진행합니다:\n${routing.map((re, i) => `  ${i + 1}. [${re.org_name}] ${re.agent_name}: ${re.subtask.split('\n')[0].slice(0, 100)}`).join('\n')}\n\n당신의 역할: **${r.org_name} (${r.agent_name})**\n`
            : '';
          const boardCtx = `\n## 협업 보드\n모든 에이전트가 공유하는 소통 공간: ${boardPath}\n\n1. 작업 시작 전 보드를 읽어 이전 실행 결과 및 다른 에이전트 상황을 파악하세요\n2. 작업 완료 후 보드 하단에 다음 형식으로 결과를 추가하세요:\n\n### ${r.org_name} (${r.agent_name}) 완료 보고 (재개)\n[수행한 작업 요약]\n`;

          const prompt = `${agent?.soul ? `## 당신의 소울\n${agent.soul}\n\n` : ''}## 미션 (재개)
전체 미션: ${mission.task}
${routingCtx}${boardCtx}
## 배정된 업무
${r.subtask}

## 지시사항
이전 실행에서 실패한 작업을 이어서 완료하세요.
Read, Edit, Write, Bash 도구를 사용해 작업을 직접 완료하세요.
완료 후 "## 완료된 작업" 섹션에 수행한 내용을 요약하세요.

지금 바로 시작하세요:`;

          const output = await callClaude(prompt, wsPath, [...modelArgs, ...mcpArgs], imagePaths, vaultEnv);

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

      send({ type: 'consolidating' });
      try {
        const resultBlock = results.map((r, i) => `### ${i + 1}. ${r.org_name} (${r.agent_name})\n${r.output}`).join('\n\n---\n\n');
        const prompt = `당신은 AI 조직의 최종 보고서 작성자입니다.

## 원래 미션
${mission.task}

## 각 조직의 완료 작업
${resultBlock}

위 결과를 종합한 최종 완료 보고서를 작성하세요.
"다음 단계", "향후 제언" 같은 미래 계획은 포함하지 마세요.

# 미션 완료 보고서
형식으로 작성하고, 결과물만 출력하세요:`;

        const finalDoc = await callClaude(prompt, process.cwd(), [], []);
        Missions.update(id, { status: 'done', final_doc: finalDoc, steps: JSON.stringify(steps) });
        send({ type: 'done', final_doc: finalDoc });
      } catch (e: unknown) {
        Missions.update(id, { status: 'failed', steps: JSON.stringify(steps) });
        send({ type: 'error', error: `통합 문서 생성 실패: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        if (mcpConfigPath) { try { fs.unlinkSync(mcpConfigPath); } catch {} }
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  });
  } catch (err) {
    console.error('[POST /api/missions/:id/resume] 오류:', err instanceof Error ? err.message : err);
    return Response.json({ ok: false, error: '미션 재개 준비 중 오류가 발생했습니다' }, { status: 500 });
  }
}
