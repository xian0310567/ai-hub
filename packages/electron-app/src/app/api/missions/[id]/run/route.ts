import { NextRequest } from 'next/server';
import { Missions, MissionJobs, McpServerConfigs } from '@/lib/db';
import { getSession, getVmSessionCookie } from '@/lib/auth';
import { readAllPersonalSecrets } from '@/lib/personal-vault';
import { scoreJob } from '@/lib/quality-scorer';
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
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const mission = Missions.get(id);
  if (!mission || mission.user_id !== user.id) return Response.json({ ok: false, error: '미션 없음' }, { status: 404 });
  if (mission.status === 'running') return Response.json({ ok: false, error: '이미 실행 중' }, { status: 409 });

  const routing: RoutingEntry[] = JSON.parse(mission.routing || '[]');
  if (!routing.length) return Response.json({ ok: false, error: '라우팅 없음' }, { status: 400 });

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

  // SSE 스트리밍
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
      };

      const steps: Step[] = routing.map((r, i) => {
        const queue = MissionJobs.queueForAgent(r.agent_id);
        const pos = queue.findIndex(j => j.id === jobIds[i]);
        return { org_name: r.org_name, agent_name: r.agent_name, status: pos > 0 ? 'waiting' : 'queued', queue_position: Math.max(0, pos) };
      });
      Missions.update(id, { status: 'running', steps: JSON.stringify(steps) });
      send({ type: 'start', steps });

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
          const output = await runAgentTask(r, mission.task, agent, id, vaultEnv, cookie, mcpConfigPath);

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

      send({ type: 'consolidating' });
      try {
        const finalDoc = await consolidateResults(mission.task, results, id);
        Missions.update(id, { status: 'done', final_doc: finalDoc, steps: JSON.stringify(steps) });
        send({ type: 'done', final_doc: finalDoc });
      } catch (e: unknown) {
        Missions.update(id, { status: 'failed', steps: JSON.stringify(steps) });
        send({ type: 'error', error: `통합 문서 생성 실패: ${e instanceof Error ? e.message : String(e)}` });
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

// ── Claude CLI 호출 ────────────────────────────────────────────────────
async function callClaude(
  prompt: string,
  cwd: string,
  modelArgs: string[] = [],
  allowTools = false,
  imagePaths: string[] = [],
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const toolArgs = allowTools ? ['--allowedTools', 'Edit,Write,Read,Bash', '--dangerously-skip-permissions'] : [];
  let lastErr: Error | null = null;
  for (let i = 0; i < 2; i++) {
    try {
      const { stdout } = await execFileAsync('claude', ['-p', prompt, ...toolArgs, ...modelArgs, ...imagePaths], {
        cwd, encoding: 'utf8', timeout: 300_000,
        env: { ...process.env, ...extraEnv },
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout.trim();
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const err = e as NodeJS.ErrnoException & { killed?: boolean; stdout?: string };
      // 타임아웃 시 1회 재시도
      if (err.killed || err.code === 'ETIMEDOUT') { await new Promise(r => setTimeout(r, 3000)); continue; }
      // maxBuffer 초과 시에만 부분 출력 반환 (다른 에러는 부분 출력을 신뢰할 수 없음)
      if (err.code === 'ERR_CHILD_PROCESS_STDOUT_MAX_BUFFER_SIZE' && err.stdout && (err.stdout as string).trim().length > 50)
        return (err.stdout as string).trim();
      throw e;
    }
  }
  throw lastErr;
}

// ── 에이전트 작업 실행 ─────────────────────────────────────────────────
async function runAgentTask(r: RoutingEntry, missionTask: string, agent: any, missionId: string, extraEnv: Record<string, string> = {}, cookie = '', mcpConfigPath: string | null = null): Promise<string> {
  let wsPath = process.cwd();
  if (agent?.workspace_id) {
    try {
      // vm-server에서 실제 workspace path 조회
      const ws = await vmGet(`/api/workspaces/${agent.workspace_id}`, cookie);
      const realPath = ws?.path?.trim();
      if (realPath && fs.existsSync(realPath)) {
        wsPath = realPath;
      } else {
        // workspace path가 없거나 존재하지 않는 경우 로컬 샌드박스 사용
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

  const mission = Missions.get(missionId);
  const imagePaths: string[] = [];
  if (mission?.images) {
    try { JSON.parse(mission.images).forEach((img: { path: string }) => { if (img.path) imagePaths.push(img.path); }); } catch {}
  }

  const modelArgs = agent?.model ? ['--model', agent.model] : [];
  const mcpArgs = mcpConfigPath ? ['--mcp-config', mcpConfigPath] : [];
  const prompt = `${agent?.soul ? `## 당신의 소울\n${agent.soul}\n\n` : ''}## 미션
전체 미션: ${missionTask}${imagePaths.length ? `\n\n**참고: ${imagePaths.length}개 이미지 첨부됨**` : ''}

## 배정된 업무
${r.subtask}

## 지시사항
Read, Edit, Write, Bash 도구를 사용해 작업을 직접 완료하세요.
완료 후 "## 완료된 작업" 섹션에 수행한 내용을 요약하세요.

지금 바로 시작하세요:`;

  return callClaude(prompt, wsPath, [...modelArgs, ...mcpArgs], true, imagePaths, extraEnv);
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

// ── 최종 통합 문서 ─────────────────────────────────────────────────────
async function consolidateResults(task: string, results: { org_name: string; agent_name: string; output: string }[], missionId: string): Promise<string> {
  const mission = Missions.get(missionId);
  const imagePaths: string[] = [];
  if (mission?.images) {
    try { JSON.parse(mission.images).forEach((img: { path: string }) => { if (img.path) imagePaths.push(img.path); }); } catch {}
  }

  const resultBlock = results.map((r, i) => `### ${i + 1}. ${r.org_name} (${r.agent_name})\n${r.output}`).join('\n\n---\n\n');
  const prompt = `당신은 AI 조직의 최종 보고서 작성자입니다.

## 원래 미션
${task}

## 각 조직의 완료 작업
${resultBlock}

위 결과를 종합한 최종 완료 보고서를 작성하세요.
"다음 단계", "향후 제언" 같은 미래 계획은 포함하지 마세요.

# 미션 완료 보고서
형식으로 작성하고, 결과물만 출력하세요:`;

  return callClaude(prompt, process.cwd(), [], false, imagePaths);
}
