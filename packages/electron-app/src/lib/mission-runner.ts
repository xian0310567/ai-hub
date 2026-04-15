/**
 * 미션 백그라운드 실행 — 스케줄러에서 호출
 * SSE 없이 미션을 실행하고 결과를 DB에 저장
 */
import { Missions, MissionJobs } from './db.js';
import { readAllPersonalSecrets } from './personal-vault.js';
import { CLAUDE_CLI, CLAUDE_ENV } from './claude-cli.js';
import { agentRun } from './openclaw-executor.js';
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
  executor?: 'c3' | 'openclaw';
  executor_reason?: string;
  capability_tags?: string[];
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

async function vmGet(endpoint: string, cookie = '') {
  try {
    const headers: Record<string, string> = cookie ? { Cookie: cookie } : {};
    const res = await fetch(`${VM_URL}${endpoint}`, { headers });
    return res.ok ? res.json() : null;
  } catch { return null; }
}

async function vmPost(endpoint: string, body: object, cookie = '') {
  try {
    const res = await fetch(`${VM_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    return res.ok ? res.json() : null;
  } catch { return null; }
}

// ── Vault 환경변수 수집 (personal_meta + org/team) ───────────────────
async function collectVaultEnv(userId: string, cookie: string): Promise<Record<string, string>> {
  if (!cookie) return {};
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
        const keyNames = secrets.map((s: { key_name: string }) => s.key_name);
        if (!keyNames.length) return;

        if (vault.scope === 'personal_meta') {
          const values = await readAllPersonalSecrets(userId, vault.id, keyNames);
          Object.assign(envVars, values);
        } else {
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
      const { stdout } = await execFileAsync(CLAUDE_CLI, ['-p', prompt, ...toolArgs, ...modelArgs, ...imagePaths], {
        cwd, encoding: 'utf8', timeout: 300_000,
        env: { ...CLAUDE_ENV, ...extraEnv },
        maxBuffer: 10 * 1024 * 1024,
      });
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

async function waitForTurn(agentId: string, jobId: string): Promise<void> {
  const MAX_WAIT = 600_000;
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT) {
    const running = MissionJobs.runningForAgent(agentId);
    if (!running) {
      const next = MissionJobs.nextQueued(agentId);
      if (!next || next.id === jobId) return;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('큐 대기 시간 초과 (10분)');
}

async function getWsPath(agent: any, cookie = ''): Promise<string> {
  if (!agent?.workspace_id) return process.cwd();
  try {
    const ws = await vmGet(`/api/workspaces/${agent.workspace_id}`, cookie);
    const realPath = ws?.path?.trim();
    if (realPath && fs.existsSync(realPath)) return realPath;
  } catch {}
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), '.data');
  const wsPath = path.join(dataDir, 'workspaces', agent.workspace_id);
  fs.mkdirSync(wsPath, { recursive: true });
  return wsPath;
}

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

export async function runMissionBackground(missionId: string, sessionCookie = ''): Promise<void> {
  const mission = Missions.get(missionId);
  if (!mission) throw new Error('미션 없음');

  const routing: RoutingEntry[] = JSON.parse(mission.routing || '[]');
  if (!routing.length) throw new Error('라우팅 없음');

  // execution_plan 파싱
  let executionPlan: ExecutionPlan | null = null;
  try {
    const stepsMeta = JSON.parse(mission.steps || '{}');
    if (stepsMeta.execution_plan) executionPlan = stepsMeta.execution_plan;
  } catch {}

  // Vault 시크릿 수집
  const vaultEnv = await collectVaultEnv(mission.user_id, sessionCookie);
  if (Object.keys(vaultEnv).length > 0)
    console.log(`[mission-runner] vault 시크릿 ${Object.keys(vaultEnv).length}개 로드됨`);

  // 협업 보드 생성
  const boardPath = buildMissionBoard(missionId, mission.task, routing);

  // 잡 생성
  const jobIds: string[] = [];
  for (const r of routing) {
    const jobId = randomUUID();
    MissionJobs.create({ id: jobId, mission_id: missionId, agent_id: r.agent_id, agent_name: r.agent_name, org_name: r.org_name, subtask: r.subtask, gate_type: r.gate_type ?? 'auto' });
    jobIds.push(jobId);
  }

  // 초기 step 상태 저장 (steps 컬럼은 항상 배열로 초기화)
  const steps: Record<string, any>[] = routing.map((r, i) => {
    const queue = MissionJobs.queueForAgent(r.agent_id);
    const pos = queue.findIndex(j => j.id === jobIds[i]);
    return { org_name: r.org_name, agent_name: r.agent_name, status: pos > 0 ? 'waiting' : 'queued', queue_position: Math.max(0, pos) };
  });
  Missions.update(missionId, { status: 'running', steps: JSON.stringify(steps) });

  // ── 1단계: pre_tasks ──
  if (executionPlan?.pre_tasks?.length) {
    for (const preTask of executionPlan.pre_tasks) {
      try {
        if (preTask.type === 'openclaw_cron') {
          const p = preTask.params as Record<string, string>;
          const cronExpr = p.cron || '';
          if (cronExpr) {
            const schedRes = await vmPost('/api/schedules', {
              name: p.name || '미션 크론',
              cron_expr: cronExpr,
              payload: JSON.stringify({ task: p.message || mission.task, description: mission.task }),
            }, sessionCookie);
            if (!schedRes) {
              console.warn(`[mission-runner] vm-server 스케줄 등록 실패`);
            }
          }
        }
      } catch (err) {
        console.warn(`[mission-runner] pre_task 실패 (${preTask.type}):`, err);
      }
    }
  }

  const results: { org_name: string; agent_name: string; output: string }[] = [];

  // ── 2단계: agent_tasks ──
  await Promise.allSettled(routing.map(async (r, idx) => {
    const jobId = jobIds[idx];
    await waitForTurn(r.agent_id, jobId);

    MissionJobs.start(jobId);
    steps[idx] = { ...steps[idx], status: 'running', queue_position: 0 };
    Missions.update(missionId, { steps: JSON.stringify(steps) });

    try {
      const agent = await vmGet(`/api/agents/${r.agent_id}`, sessionCookie);
      const wsPath = await getWsPath(agent, sessionCookie);
      const modelArgs = agent?.model ? ['--model', agent.model] : [];
      const routingCtx = routing.length > 1
        ? `\n## 전체 실행 계획\n이 미션은 다음 조직들이 동시에 진행합니다:\n${routing.map((re, i) => `  ${i + 1}. [${re.org_name}] ${re.agent_name}: ${re.subtask.split('\n')[0].slice(0, 100)}`).join('\n')}\n\n당신의 역할: **${r.org_name} (${r.agent_name})**\n`
        : '';
      const boardCtx = `\n## 협업 보드\n모든 에이전트가 공유하는 소통 공간: ${boardPath}\n\n1. 작업 시작 전 보드를 읽어 다른 에이전트의 진행 상황을 파악하세요\n2. 의존성, 이슈, 중요 발견 사항을 보드에 기록하세요\n3. 작업 완료 후 보드 하단에 다음 형식으로 결과를 추가하세요:\n\n### ${r.org_name} (${r.agent_name}) 완료 보고\n[수행한 작업 요약]\n`;
      const prompt = `${agent?.soul ? `## 당신의 소울\n${agent.soul}\n\n` : ''}## 미션
전체 미션: ${mission.task}
${routingCtx}${boardCtx}
## 배정된 업무
${r.subtask}

## 지시사항
Read, Edit, Write, Bash 도구를 사용해 작업을 직접 완료하세요.
완료 후 "## 완료된 작업" 섹션에 수행한 내용을 요약하세요.

지금 바로 시작하세요:`;

      // executor에 따라 실행 수단 분기
      let output: string;
      if (r.executor === 'openclaw') {
        const result = await agentRun({
          message: prompt,
          agent: r.openclaw_params?.session_key || r.agent_id,
          thinking: r.openclaw_params?.thinking,
          model: r.openclaw_params?.model || agent?.model,
          timeout: r.openclaw_params?.timeout_seconds,
          sessionId: r.openclaw_params?.session_key,
        });
        if (!result.ok) throw new Error(result.error || 'OpenClaw 에이전트 실행 실패');
        output = result.output || '';
      } else {
        output = await callClaude(prompt, wsPath, modelArgs, true, [], vaultEnv);
      }

      // 증거 없는 완료 불인정
      if (!output || output.trim().length < 50) {
        throw new Error('완료 증거 미제출 — 결과물이 너무 짧거나 비어 있음');
      }

      MissionJobs.finish(jobId, output);
      steps[idx] = { ...steps[idx], status: 'done', output };
      Missions.update(missionId, { steps: JSON.stringify(steps) });
      results.push({ org_name: r.org_name, agent_name: r.agent_name, output });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      MissionJobs.fail(jobId, msg);
      steps[idx] = { ...steps[idx], status: 'failed', error: msg };
      Missions.update(missionId, { steps: JSON.stringify(steps) });
      results.push({ org_name: r.org_name, agent_name: r.agent_name, output: `[실패: ${msg}]` });
    }
  }));

  // ── 3단계: post_tasks ──
  if (executionPlan?.post_tasks?.length) {
    for (const postTask of executionPlan.post_tasks) {
      try {
        if (postTask.type === 'openclaw_deliver') {
          const p = postTask.params as Record<string, string>;
          const summary = results.map(r => `[${r.org_name}] ${r.output.slice(0, 200)}`).join('\n');
          await agentRun({ message: `다음 내용을 ${p.channel || 'slack'}의 ${p.to || '기본 채널'}에 전송하세요:\n\n${p.message || summary}`, deliver: true, channel: p.channel, to: p.to });
        }
      } catch (err) {
        console.warn(`[mission-runner] post_task 실패 (${postTask.type}):`, err);
      }
    }
  }

  // 통합 문서 생성
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

    const finalDoc = await callClaude(prompt, process.cwd());
    Missions.update(missionId, { status: 'done', final_doc: finalDoc, steps: JSON.stringify(steps) });
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    Missions.update(missionId, { status: 'failed', error: `통합 문서 생성 실패: ${errMsg}`, steps: JSON.stringify(steps) });
    throw e;
  }
}
