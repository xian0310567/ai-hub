import { NextRequest } from 'next/server';
import { Missions, MissionJobs, Agents, Divisions, Workspaces, Tasks } from '@/lib/db';
import { getSession } from '@/lib/auth';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

interface RoutingEntry {
  org_id: string;
  org_type: string;
  org_name: string;
  agent_id: string;
  agent_name: string;
  subtask: string;
}

interface Step {
  org_name: string;
  agent_name: string;
  status: 'queued' | 'waiting' | 'running' | 'done' | 'failed';
  queue_position?: number;
  output?: string;
  error?: string;
}

// POST /api/missions/[id]/run — 미션 실행 (큐 기반 + SSE 스트리밍)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const mission = Missions.get(id);
  if (!mission || mission.user_id !== user.id) {
    return Response.json({ ok: false, error: '미션 없음' }, { status: 404 });
  }
  if (mission.status === 'running') {
    return Response.json({ ok: false, error: '이미 실행 중입니다' }, { status: 409 });
  }

  const routing: RoutingEntry[] = JSON.parse(mission.routing || '[]');
  if (!routing.length) {
    return Response.json({ ok: false, error: '라우팅이 없습니다' }, { status: 400 });
  }

  // 잡 + 태스크 생성 (큐에 등록)
  const jobIds: string[] = [];
  const taskIds: string[] = [];
  for (const r of routing) {
    const jobId = randomUUID();
    MissionJobs.create({
      id: jobId,
      mission_id: id,
      agent_id: r.agent_id,
      agent_name: r.agent_name,
      org_name: r.org_name,
      subtask: r.subtask,
    });
    jobIds.push(jobId);

    // 태스크 레코드 생성 (태스크 페이지에서 추적 가능)
    const taskId = randomUUID();
    const shortTitle = r.subtask.length > 80 ? r.subtask.slice(0, 80) + '…' : r.subtask;
    Tasks.create({
      id: taskId,
      user_id: mission.user_id,
      agent_id: r.agent_id,
      agent_name: r.agent_name,
      title: shortTitle,
      description: `[미션] ${mission.task}`,
      status: 'pending',
      result: '',
    });
    taskIds.push(taskId);
  }

  // SSE 스트리밍
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: any) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
      };

      // 초기 상태
      const steps: Step[] = routing.map((r, i) => {
        const queue = MissionJobs.queueForAgent(r.agent_id);
        const pos = queue.findIndex(j => j.id === jobIds[i]);
        const running = MissionJobs.runningForAgent(r.agent_id);
        return {
          org_name: r.org_name,
          agent_name: r.agent_name,
          status: (running || pos > 0) ? 'waiting' as const : 'queued' as const,
          queue_position: pos,
        };
      });
      Missions.update(id, { status: 'running', steps: JSON.stringify(steps) });
      send({ type: 'start', steps });

      // ── 각 잡을 큐 순서에 맞게 실행 ──
      const results: { org_name: string; agent_name: string; output: string }[] = [];

      const promises = routing.map(async (r, idx) => {
        const jobId = jobIds[idx];
        const taskId = taskIds[idx];

        // 큐 대기
        await waitForTurn(r.agent_id, jobId, (pos) => {
          steps[idx].status = 'waiting';
          steps[idx].queue_position = pos;
          Missions.update(id, { steps: JSON.stringify(steps) });
          send({ type: 'step', idx, status: 'waiting', org_name: r.org_name, agent_name: r.agent_name, queue_position: pos });
        });

        // 내 차례 — 실행
        MissionJobs.start(jobId);
        Tasks.update(taskId, { status: 'running' });
        steps[idx].status = 'running';
        steps[idx].queue_position = 0;
        Missions.update(id, { steps: JSON.stringify(steps) });
        send({ type: 'step', idx, status: 'running', org_name: r.org_name, agent_name: r.agent_name });

        try {
          const output = await runAgentTask(r, mission.task);
          MissionJobs.finish(jobId, output);
          Tasks.update(taskId, { status: 'done', result: output });
          steps[idx].status = 'done';
          steps[idx].output = output;
          Missions.update(id, { steps: JSON.stringify(steps) });
          send({ type: 'step', idx, status: 'done', org_name: r.org_name, agent_name: r.agent_name, output });
          results.push({ org_name: r.org_name, agent_name: r.agent_name, output });
        } catch (e: any) {
          MissionJobs.fail(jobId, e.message);
          Tasks.update(taskId, { status: 'failed', result: e.message });
          steps[idx].status = 'failed';
          steps[idx].error = e.message;
          Missions.update(id, { steps: JSON.stringify(steps) });
          send({ type: 'step', idx, status: 'failed', org_name: r.org_name, agent_name: r.agent_name, error: e.message });
          results.push({ org_name: r.org_name, agent_name: r.agent_name, output: `[실패: ${e.message}]` });
        }
      });

      await Promise.allSettled(promises);

      // ── 최종 통합 문서 ──
      send({ type: 'consolidating' });
      try {
        const finalDoc = await consolidateResults(mission.task, results);
        Missions.update(id, { status: 'done', final_doc: finalDoc, steps: JSON.stringify(steps) });
        send({ type: 'done', final_doc: finalDoc });
      } catch (e: any) {
        Missions.update(id, { status: 'failed', steps: JSON.stringify(steps) });
        send({ type: 'error', error: `통합 문서 생성 실패: ${e.message}` });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// ── 큐 대기 ────────────────────────────────────────────────────────
async function waitForTurn(agentId: string, jobId: string, onWait: (pos: number) => void): Promise<void> {
  const MAX_WAIT = 600000;
  const POLL_INTERVAL = 2000;
  const start = Date.now();

  while (Date.now() - start < MAX_WAIT) {
    const running = MissionJobs.runningForAgent(agentId);
    if (!running) {
      const next = MissionJobs.nextQueued(agentId);
      if (next && next.id === jobId) return;
      if (!next) return;
    }
    const queue = MissionJobs.queueForAgent(agentId);
    const pos = queue.findIndex(j => j.id === jobId);
    onWait(pos);
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }

  throw new Error('큐 대기 시간 초과 (10분)');
}

// ── Claude CLI 실행 (비동기 + 재시도) ──────────────────────────────
const CLAUDE_TIMEOUT = 300_000; // 5분
const MAX_RETRIES = 2;

async function callClaude(prompt: string, cwd: string, modelArgs: string[] = [], allowTools = false): Promise<string> {
  let lastErr: Error | null = null;

  const toolArgs = allowTools
    ? ['--allowedTools', 'Edit,Write,Read,Bash', '--dangerously-skip-permissions']
    : [];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const { stdout } = await execFileAsync('claude', ['-p', prompt, ...toolArgs, ...modelArgs], {
        cwd,
        encoding: 'utf8',
        timeout: CLAUDE_TIMEOUT,
        env: { ...process.env },
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      return stdout.trim();
    } catch (e: any) {
      lastErr = e;
      // 타임아웃이면 재시도, 그 외 에러는 즉시 실패
      if (e.killed || e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') {
        // 재시도 전 잠깐 대기
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      // stdout이 있으면 부분 결과라도 반환
      if (e.stdout && e.stdout.trim().length > 50) {
        return e.stdout.trim();
      }
      throw e;
    }
  }

  throw lastErr || new Error('Claude CLI 호출 실패');
}

// ── 에이전트에게 업무 위임 ──────────────────────────────────────────
async function runAgentTask(r: RoutingEntry, missionTask: string): Promise<string> {
  const agent = Agents.get(r.agent_id);
  if (!agent) throw new Error(`에이전트 "${r.agent_name}" 없음`);

  let wsPath: string;
  if (agent.org_level === 'division') {
    const div = Divisions.get(agent.workspace_id);
    wsPath = div?.ws_path || process.cwd();
  } else {
    const ws = Workspaces.get(agent.workspace_id);
    wsPath = ws?.path || process.cwd();
  }

  const agentSoul = agent.soul || '';
  const modelArgs = agent.model ? ['--model', agent.model] : [];

  const prompt = `${agentSoul ? `## 당신의 소울\n${agentSoul}\n\n` : ''}## 미션
전체 미션: ${missionTask}

## 당신에게 배정된 업무
${r.subtask}

## 지시사항
1. 위 업무를 즉시 수행하세요.
2. 결과물을 구체적이고 실용적으로 작성하세요.
3. 마크다운 형식으로 깔끔하게 정리하세요.
4. 완료 후 "## 결과 요약" 섹션으로 핵심을 정리하세요.

결과물만 출력하세요 (설명이나 인사말 없이):`;

  return await callClaude(prompt, wsPath, modelArgs, true);
}

// ── 최종 통합 문서 생성 ─────────────────────────────────────────────
async function consolidateResults(
  task: string,
  results: { org_name: string; agent_name: string; output: string }[]
): Promise<string> {
  const resultBlock = results.map((r, i) =>
    `### ${i + 1}. ${r.org_name} (${r.agent_name})\n${r.output}`
  ).join('\n\n---\n\n');

  const prompt = `당신은 AI 조직의 최종 보고서 작성자입니다.

## 원래 미션
${task}

## 각 조직의 결과물
${resultBlock}

## 요청
위 결과물들을 종합하여 하나의 최종 보고서를 작성해주세요.

보고서 형식:
# 미션 결과 보고서
## 미션 개요
(원래 요청 요약)

## 참여 조직
(어떤 조직이 어떤 업무를 맡았는지)

## 진행 결과
### [조직1]
(핵심 결과 요약)

### [조직2]
(핵심 결과 요약)

## 종합 결론
(전체를 아우르는 결론 및 다음 단계 제언)

---
결과물만 출력 (설명 없이):`;

  return await callClaude(prompt, process.cwd());
}
