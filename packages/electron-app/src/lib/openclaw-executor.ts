/**
 * OpenClaw 실행 인터페이스
 *
 * 미션 오케스트레이터가 OpenClaw CLI/Gateway를 프로그래밍 방식으로 호출하는 통합 인터페이스.
 * 크론 관리(등록/조회/삭제)와 에이전트 1회 실행을 지원하며,
 * Gateway 가용 시 HTTP API, 불가 시 CLI 직접 호출로 폴백한다.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { findOpenClawBinary } from './gateway-manager';
import { isGatewayAvailable, isGatewayReady } from './openclaw-client';
import { CLAUDE_CLI, CLAUDE_ENV } from './claude-cli';

const execFileAsync = promisify(execFile);

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

// ── 타입 ──────────────────────────────────────────────────────────────

export interface CronAddParams {
  name: string;
  cron?: string;        // "0 1 * * *"
  at?: string;          // ISO 8601 datetime
  every?: string;       // "10m"
  tz?: string;          // "Asia/Seoul"
  message: string;
  agent?: string;
  thinking?: string;    // off|minimal|low|medium|high
  model?: string;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  createdAtMs?: number;
  schedule?: { kind: string; expr: string; tz?: string };
  payload?: { kind: string; message: string };
  state?: { nextRunAtMs?: number };
}

export interface CronResult {
  ok: boolean;
  jobId?: string;
  error?: string;
}

export interface AgentRunParams {
  message: string;
  agent?: string;
  thinking?: string;
  model?: string;
  timeout?: number;     // seconds (default 300)
  sessionId?: string;
  deliver?: boolean;
  channel?: string;
  to?: string;

  // 통합 실행 확장 필드
  cwd?: string;
  allowTools?: boolean;
  imagePaths?: string[];
  systemPrompt?: string;
  mcpConfigPath?: string;
  extraEnv?: Record<string, string>;
}

export interface AgentResult {
  ok: boolean;
  output?: string;
  error?: string;
}

// ── 폴백 래퍼 ─────────────────────────────────────────────────────────

/**
 * OpenClaw 호출을 시도하고, 실패 시 fallback을 실행한다.
 * Gateway 미가용이거나 openclawFn이 throw하면 fallbackFn으로 전환.
 */
export async function executeWithFallback<T>(
  openclawFn: () => Promise<T>,
  fallbackFn: () => Promise<T>,
  context: string,
): Promise<T> {
  if (await isGatewayReady()) {
    try {
      return await openclawFn();
    } catch (err) {
      console.warn(`[Orchestrator] OpenClaw 실패 (${context}), 폴백 실행:`, err);
      return fallbackFn();
    }
  }
  return fallbackFn();
}

// ── 크론 관리 ─────────────────────────────────────────────────────────

export async function cronAdd(params: CronAddParams): Promise<CronResult> {
  const binary = findOpenClawBinary();
  if (!binary) return { ok: false, error: 'openclaw_not_found' };

  const args = ['cron', 'add', '--name', params.name, '--json'];

  // 스케줄 타입 (상호 배타)
  if (params.cron) args.push('--cron', params.cron);
  else if (params.at) args.push('--at', params.at);
  else if (params.every) args.push('--every', params.every);

  if (params.tz) args.push('--tz', params.tz);
  if (params.message) args.push('--message', params.message);
  if (params.agent) args.push('--agent', params.agent);
  if (params.thinking) args.push('--thinking', params.thinking);
  if (params.model) args.push('--model', params.model);

  try {
    const { stdout } = await execFileAsync(binary, args, {
      encoding: 'utf8',
      timeout: 30_000,
    });
    const parsed = JSON.parse(stdout);
    return { ok: true, jobId: parsed.id ?? parsed.jobId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function cronList(): Promise<CronJob[]> {
  const binary = findOpenClawBinary();
  if (!binary) return [];

  try {
    const { stdout } = await execFileAsync(binary, ['cron', 'list', '--json'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    const parsed = JSON.parse(stdout);
    return parsed.jobs ?? parsed;
  } catch {
    return [];
  }
}

export async function cronRemove(jobId: string): Promise<{ ok: boolean; error?: string }> {
  const binary = findOpenClawBinary();
  if (!binary) return { ok: false, error: 'openclaw_not_found' };

  try {
    await execFileAsync(binary, ['cron', 'rm', jobId, '--json'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function cronEnable(jobId: string): Promise<{ ok: boolean; error?: string }> {
  const binary = findOpenClawBinary();
  if (!binary) return { ok: false, error: 'openclaw_not_found' };

  try {
    await execFileAsync(binary, ['cron', 'enable', jobId], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function cronDisable(jobId: string): Promise<{ ok: boolean; error?: string }> {
  const binary = findOpenClawBinary();
  if (!binary) return { ok: false, error: 'openclaw_not_found' };

  try {
    await execFileAsync(binary, ['cron', 'disable', jobId], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── 에이전트 실행 ─────────────────────────────────────────────────────

export async function agentRun(params: AgentRunParams): Promise<AgentResult> {
  // Gateway ready 시 HTTP API 우선
  if (await isGatewayReady()) {
    try {
      const result = await agentRunViaGateway(params);
      if (result.ok) return result;
      // Gateway가 응답은 했으나 실패 (500 등) → CLI 폴백
      console.warn(`[Orchestrator] Gateway 에이전트 실행 실패 (${result.error}), CLI 폴백`);
    } catch (err) {
      console.warn('[Orchestrator] Gateway 에이전트 실행 에러, CLI 폴백:', err);
    }
  }
  // 폴백: CLI 직접 호출
  return agentRunViaCli(params);
}

async function agentRunViaGateway(params: AgentRunParams): Promise<AgentResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (GATEWAY_TOKEN) headers['Authorization'] = `Bearer ${GATEWAY_TOKEN}`;

  // 시스템 프롬프트 + 이미지 경로를 메시지에 포함
  const messages: { role: string; content: string | object[] }[] = [];

  if (params.systemPrompt) {
    messages.push({ role: 'system', content: params.systemPrompt });
  }

  // 이미지가 있으면 멀티모달 메시지 구성
  if (params.imagePaths?.length) {
    const content: object[] = [{ type: 'text', text: params.message }];
    for (const imgPath of params.imagePaths) {
      content.push({
        type: 'image_url',
        image_url: { url: `file://${imgPath}` },
      });
    }
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: params.message });
  }

  // Gateway 요청 body 구성
  const body: Record<string, unknown> = {
    model: params.agent ? `openclaw/${params.agent}` : 'openclaw',
    messages,
    stream: false,
  };

  // Gateway 확장 필드 (OpenClaw이 CLI 백엔드에 전달)
  // 보안: extraEnv(vault 시크릿)는 HTTP body에 포함하지 않음.
  // Gateway 프로세스의 환경변수로 이미 전달됨 (gateway-manager.ts 참조)
  if (params.cwd || params.allowTools || params.mcpConfigPath) {
    body['openclaw'] = {
      cwd: params.cwd,
      allow_tools: params.allowTools,
      mcp_config_path: params.mcpConfigPath,
    };
  }

  const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((params.timeout ?? 300) * 1000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return { ok: false, error: `Gateway ${res.status}: ${errBody}` };
  }

  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  return { ok: true, output: data.choices?.[0]?.message?.content ?? '' };
}

async function agentRunViaCli(params: AgentRunParams): Promise<AgentResult> {
  // claude CLI 직접 실행 (구독 인증 사용)
  const args = ['-p', params.message];

  if (params.model) args.push('--model', params.model);
  if (params.allowTools) args.push('--allowedTools', 'Edit,Write,Read,Bash', '--dangerously-skip-permissions');
  if (params.systemPrompt) args.push('--append-system-prompt', params.systemPrompt);
  if (params.mcpConfigPath) args.push('--mcp-config', params.mcpConfigPath);

  // 이미지 경로 추가
  if (params.imagePaths?.length) {
    for (const imgPath of params.imagePaths) {
      args.push(imgPath);
    }
  }

  try {
    const { stdout } = await execFileAsync(CLAUDE_CLI, args, {
      encoding: 'utf8',
      timeout: (params.timeout ?? 300) * 1000 + 10_000,
      cwd: params.cwd || process.cwd(),
      env: { ...CLAUDE_ENV, ...params.extraEnv },
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    // 타임아웃 시 1회 재시도
    const e = err as NodeJS.ErrnoException & { killed?: boolean; stdout?: string };
    if (e.killed || e.code === 'ETIMEDOUT') {
      try {
        await new Promise(r => setTimeout(r, 3000));
        const { stdout } = await execFileAsync(CLAUDE_CLI, args, {
          encoding: 'utf8',
          timeout: (params.timeout ?? 300) * 1000 + 10_000,
          cwd: params.cwd || process.cwd(),
          env: { ...CLAUDE_ENV, ...params.extraEnv },
          maxBuffer: 10 * 1024 * 1024,
        });
        return { ok: true, output: stdout.trim() };
      } catch (retryErr) {
        return { ok: false, error: retryErr instanceof Error ? retryErr.message : String(retryErr) };
      }
    }
    // maxBuffer 초과 시 부분 출력 반환
    if (e.code === 'ERR_CHILD_PROCESS_STDOUT_MAX_BUFFER_SIZE' && e.stdout && e.stdout.trim().length > 50) {
      return { ok: true, output: e.stdout.trim() };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
