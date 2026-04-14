/**
 * 에이전트 실행 (standalone)
 *
 * openclaw의 callGateway() 또는 CLI 직접 호출을 통해
 * Claude CLI 백엔드로 에이전트를 실행합니다.
 *
 * 두 가지 경로를 지원:
 * 1. Gateway 경유: Gateway가 실행 중이면 HTTP API로 호출
 * 2. CLI 직접 호출: Gateway 없이 claude 바이너리를 직접 spawn
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { resolveClaudeCli } from './claude-cli-resolver.js';
import { isGatewayReady } from './gateway.js';
import { diagnose, setup } from './setup.js';

const execFileAsync = promisify(execFile);

// ── 타입 ──────────────────────────────────────────────────────────────

export interface AgentRunOptions {
  /** 에이전트에게 보낼 메시지 */
  message: string;
  /** 모델 (기본: claude-sonnet-4-6) */
  model?: string;
  /** 작업 디렉터리 */
  cwd?: string;
  /** 시스템 프롬프트 */
  systemPrompt?: string;
  /** 이미지 파일 경로 배열 */
  imagePaths?: string[];
  /** 타임아웃 (초, 기본 300) */
  timeout?: number;
  /** 추가 환경변수 */
  extraEnv?: Record<string, string>;
  /** thinking 수준: off | minimal | low | medium | high */
  thinking?: string;
  /** Gateway 포트 (기본 18789) */
  gatewayPort?: number;
  /** Gateway 사용 강제 비활성화 (CLI 직접 호출) */
  forceCliMode?: boolean;
}

export interface AgentRunResult {
  ok: boolean;
  output?: string;
  error?: string;
  mode: 'gateway' | 'cli';
}

// ── 에이전트 실행 ─────────────────────────────────────────────────────

/**
 * 에이전트를 실행합니다.
 * Gateway가 실행 중이면 Gateway 경유, 아니면 Claude CLI 직접 호출.
 *
 * @example
 * ```typescript
 * const result = await runAgent({
 *   message: '현재 디렉터리의 구조를 설명해주세요',
 *   cwd: '/my/project',
 * });
 * console.log(result.output);
 * ```
 */
export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  // 설정이 안 되어 있으면 자동 설정
  const status = diagnose();
  if (!status.ready) {
    setup();
  }

  // Gateway 경유 시도
  if (!opts.forceCliMode) {
    const port = opts.gatewayPort ?? parseInt(process.env.OPENCLAW_GATEWAY_PORT || '18789', 10);
    if (await isGatewayReady(port)) {
      try {
        const result = await runViaGateway(opts, port);
        if (result.ok) return result;
        console.warn(`[standalone-openclaw] Gateway 실행 실패, CLI 폴백: ${result.error}`);
      } catch (err) {
        console.warn('[standalone-openclaw] Gateway 연결 에러, CLI 폴백:', err);
      }
    }
  }

  // CLI 직접 호출
  return runViaCli(opts);
}

// ── Gateway 경유 ─────────────────────────────────────────────────────

async function runViaGateway(opts: AgentRunOptions, port: number): Promise<AgentRunResult> {
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || '';

  const messages: Array<{ role: string; content: string | object[] }> = [];

  if (opts.systemPrompt) {
    messages.push({ role: 'system', content: opts.systemPrompt });
  }

  if (opts.imagePaths?.length) {
    const content: object[] = [{ type: 'text', text: opts.message }];
    for (const imgPath of opts.imagePaths) {
      content.push({
        type: 'image_url',
        image_url: { url: `file://${imgPath}` },
      });
    }
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: opts.message });
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const body: Record<string, unknown> = {
    model: opts.model ? `claude-cli/${opts.model}` : 'claude-cli/claude-sonnet-4-6',
    messages,
    stream: false,
  };

  if (opts.cwd) {
    body['openclaw'] = { cwd: opts.cwd };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((opts.timeout ?? 300) * 1000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return { ok: false, error: `Gateway ${res.status}: ${errBody}`, mode: 'gateway' };
  }

  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  return {
    ok: true,
    output: data.choices?.[0]?.message?.content ?? '',
    mode: 'gateway',
  };
}

// ── CLI 직접 호출 ────────────────────────────────────────────────────

async function runViaCli(opts: AgentRunOptions): Promise<AgentRunResult> {
  const claude = resolveClaudeCli();
  if (!claude.resolved) {
    return {
      ok: false,
      error: 'Claude CLI를 찾을 수 없습니다. npm i -g @anthropic-ai/claude-code 로 설치하세요.',
      mode: 'cli',
    };
  }

  const args = ['-p', opts.message];

  if (opts.model) args.push('--model', opts.model);
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
  if (opts.thinking) args.push('--thinking', opts.thinking);

  if (opts.imagePaths?.length) {
    for (const imgPath of opts.imagePaths) {
      args.push(imgPath);
    }
  }

  // Claude CLI 바이너리 디렉터리를 PATH에 추가
  const binDir = path.dirname(claude.path);
  const currentPath = process.env.PATH || '';
  const envPath = currentPath.includes(binDir)
    ? currentPath
    : `${binDir}:${currentPath}`;

  try {
    const { stdout } = await execFileAsync(claude.path, args, {
      encoding: 'utf8',
      timeout: (opts.timeout ?? 300) * 1000 + 10_000,
      cwd: opts.cwd || process.cwd(),
      env: { ...process.env, PATH: envPath, ...opts.extraEnv },
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, output: stdout.trim(), mode: 'cli' };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; stdout?: string };

    // 타임아웃 시 1회 재시도
    if (e.killed || e.code === 'ETIMEDOUT') {
      try {
        await new Promise(r => setTimeout(r, 3000));
        const { stdout } = await execFileAsync(claude.path, args, {
          encoding: 'utf8',
          timeout: (opts.timeout ?? 300) * 1000 + 10_000,
          cwd: opts.cwd || process.cwd(),
          env: { ...process.env, PATH: envPath, ...opts.extraEnv },
          maxBuffer: 10 * 1024 * 1024,
        });
        return { ok: true, output: stdout.trim(), mode: 'cli' };
      } catch (retryErr) {
        return { ok: false, error: retryErr instanceof Error ? retryErr.message : String(retryErr), mode: 'cli' };
      }
    }

    // maxBuffer 초과 시 부분 출력 반환
    if (e.stdout && e.stdout.trim().length > 50) {
      return { ok: true, output: e.stdout.trim(), mode: 'cli' };
    }

    return { ok: false, error: err instanceof Error ? err.message : String(err), mode: 'cli' };
  }
}
