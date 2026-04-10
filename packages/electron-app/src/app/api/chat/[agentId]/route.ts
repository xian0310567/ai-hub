/**
 * 통합 에이전트 채팅 API (Gateway 우선, CLI fallback)
 *
 * POST /api/chat/[agentId]
 * - Gateway 가용 → OpenClaw Gateway 경유 (SSE 스트리밍)
 * - Gateway 불가 → 기존 Claude CLI 직접 실행 (fallback)
 *
 * GET /api/chat/[agentId]
 * - 현재 모드(gateway/cli) 및 세션 상태 조회
 */

import { NextRequest } from 'next/server';
import { spawn, execSync } from 'child_process';
import { CLAUDE_CLI, CLAUDE_ENV, claudeSpawnError } from '@/lib/claude-cli';
import { ChatLogs } from '@/lib/db';
import { randomUUID } from 'crypto';
import { getSession, getVmSessionCookie, getUserSessionsDir } from '@/lib/auth';
import {
  sendToGateway,
  isGatewayAvailable,
  killSession,
} from '@/lib/openclaw-client';
import path from 'path';
import fs from 'fs';

const VM_URL = process.env.VM_SERVER_URL || 'http://localhost:4000';

// ── 타입 ──────────────────────────────────────────────────────────────

interface VmAgent {
  id: string; org_id: string; workspace_id: string; team_id?: string;
  org_level?: string; is_lead: number; name: string; command_name?: string;
  harness_pattern?: string; model?: string; soul?: string;
}

// ── VM 헬퍼 ───────────────────────────────────────────────────────────

async function fetchAgent(agentId: string, cookie: string): Promise<VmAgent | null> {
  try {
    const res = await fetch(`${VM_URL}/api/agents/${agentId}`, {
      headers: { Cookie: cookie },
    });
    if (!res.ok) return null;
    return res.json() as Promise<VmAgent>;
  } catch { return null; }
}

async function fetchWorkspacePath(workspaceId: string, cookie: string, isDivision: boolean): Promise<string | null> {
  try {
    const endpoint = isDivision ? `/api/divisions/${workspaceId}` : `/api/workspaces/${workspaceId}`;
    const res = await fetch(`${VM_URL}${endpoint}`, { headers: { Cookie: cookie } });
    if (!res.ok) return null;
    const data = await res.json() as { path?: string; ws_path?: string };
    return data.ws_path ?? data.path ?? null;
  } catch { return null; }
}

// ── CLI fallback ──────────────────────────────────────────────────────

function getSessionsDir(userId: string): string {
  const dir = getUserSessionsDir(userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function hasCliSession(userId: string, agentId: string): boolean {
  try {
    return JSON.parse(fs.readFileSync(path.join(getSessionsDir(userId), `${agentId}.state`), 'utf8')).ok;
  } catch { return false; }
}

function markCliSession(userId: string, agentId: string) {
  fs.writeFileSync(path.join(getSessionsDir(userId), `${agentId}.state`), JSON.stringify({ ok: true, ts: Date.now() }), 'utf8');
}

function clearCliSession(userId: string, agentId: string) {
  try { fs.unlinkSync(path.join(getSessionsDir(userId), `${agentId}.state`)); } catch {}
}

function stripAnsi(s: string) {
  return s.replace(/\x1B\[[0-9;]*[mGKHFJA-Z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '').replace(/\r/g, '');
}

function isClaudeAvailable(): boolean {
  try { execSync(`${CLAUDE_CLI} --version`, { stdio: 'ignore', timeout: 3000 }); return true; } catch { return false; }
}

function runClaudeCli(
  cwd: string, message: string, userId: string, agentId: string,
  model?: string | null, onDone?: (full: string) => void,
): ReadableStream {
  const isFirst = !hasCliSession(userId, agentId);
  const modelArgs = model ? ['--model', model] : [];
  const args = isFirst
    ? ['-p', message, ...modelArgs]
    : ['--continue', '-p', message, ...modelArgs];
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      const proc = spawn(CLAUDE_CLI, args, { cwd, env: CLAUDE_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
      proc.stdout.setEncoding('utf8');
      let buf = ''; let full = '';
      proc.stdout.on('data', (chunk: string) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const l of lines) { const s = stripAnsi(l); full += s + '\n'; controller.enqueue(encoder.encode(s + '\n')); }
      });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (c: string) => {
        const t = stripAnsi(c);
        if (t.toLowerCase().includes('error') && !t.includes('✓')) {
          controller.enqueue(encoder.encode(`[!] ${t}`));
        }
      });
      proc.on('close', (code) => {
        if (buf) { const s = stripAnsi(buf); full += s; controller.enqueue(encoder.encode(s)); }
        if (code === 0) { markCliSession(userId, agentId); onDone?.(full.trim()); }
        else controller.enqueue(encoder.encode(`\n[종료 코드: ${code}]`));
        try { controller.close(); } catch {}
      });
      proc.on('error', (e) => {
        controller.enqueue(encoder.encode(`[claude CLI 오류] ${claudeSpawnError(e)}`));
        try { controller.close(); } catch {}
      });
      const t = setTimeout(() => { proc.kill(); try { controller.enqueue(encoder.encode('\n[90초 타임아웃]')); controller.close(); } catch {} }, 90000);
      proc.on('close', () => clearTimeout(t));
    },
  });
}

// ── POST ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { agentId } = await params;
  const body = await req.json() as { message?: string; reset?: boolean; sessionKey?: string };

  if (body.reset) {
    clearCliSession(user.id, agentId);
    const sessionKey = body.sessionKey || `${user.id}:${agentId}`;
    await killSession(sessionKey).catch(() => {});
    ChatLogs.clear(user.id, agentId);
    return Response.json({ ok: true });
  }

  if (!body.message) return Response.json({ ok: false, error: 'message required' }, { status: 400 });

  const sessionKey = body.sessionKey || `${user.id}:${agentId}`;

  ChatLogs.add({ id: randomUUID(), user_id: user.id, agent_id: agentId, role: 'user', content: body.message, session_key: sessionKey });

  const cookie = getVmSessionCookie(req);
  const agent = await fetchAgent(agentId, cookie);
  if (!agent) return Response.json({ ok: false, error: '에이전트를 찾을 수 없습니다' }, { status: 404 });

  // Gateway 우선 시도
  const gatewayAvailable = await isGatewayAvailable();

  if (gatewayAvailable) {
    return respondViaGateway(user.id, agentId, agent, body.message, body.sessionKey);
  }

  // CLI fallback
  return respondViaCli(user.id, agentId, agent, body.message, cookie);
}

// ── Gateway 모드 ──────────────────────────────────────────────────────

function respondViaGateway(
  userId: string, agentId: string, agent: VmAgent, message: string, sessionKey?: string,
): Response {
  const key = sessionKey || `${userId}:${agentId}`;
  const openclawAgentId = agent.command_name || agentId;

  const stream = sendToGateway({
    agentId: openclawAgentId,
    message,
    sessionKey: key,
    model: agent.model ? `claude-cli/${agent.model}` : undefined,
    stream: true,
  });

  const [browserStream, logStream] = stream.tee();

  // 백그라운드 로그 저장
  (async () => {
    const reader = logStream.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value, { stream: true });
      }
      if (fullText.trim()) {
        ChatLogs.add({ id: randomUUID(), user_id: userId, agent_id: agentId, role: 'assistant', content: fullText.trim(), session_key: key });
      }
    } catch (err) {
      console.error(`[ChatLog] 대화 기록 저장 실패 (agent=${agentId}):`, err);
    } finally {
      reader.releaseLock();
    }
  })();

  return new Response(browserStream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'X-Chat-Mode': 'gateway',
      'X-OpenClaw-Session-Key': key,
    },
  });
}

// ── CLI 모드 ──────────────────────────────────────────────────────────

async function respondViaCli(
  userId: string, agentId: string, agent: VmAgent, message: string, cookie: string,
): Promise<Response> {
  if (!isClaudeAvailable()) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('Claude CLI를 사용할 수 없습니다.\nOpenClaw Gateway를 시작하거나 claude CLI를 설치해주세요.'));
        c.close();
      },
    });
    return new Response(stream, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Chat-Mode': 'error' },
    });
  }

  const isDivision = agent.org_level === 'division';
  const wsPath = await fetchWorkspacePath(agent.workspace_id, cookie, isDivision);
  if (!wsPath) {
    return Response.json({ ok: false, error: '워크스페이스를 찾을 수 없습니다' }, { status: 404 });
  }

  const saveLog = (full: string) => {
    try { ChatLogs.add({ id: randomUUID(), user_id: userId, agent_id: agentId, role: 'assistant', content: full }); } catch {}
  };

  return new Response(runClaudeCli(wsPath, message, userId, agentId, agent.model, saveLog), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'X-Chat-Mode': 'cli',
    },
  });
}

// ── GET ───────────────────────────────────────────────────────────────

export async function GET(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { agentId } = await params;
  const gatewayAvailable = await isGatewayAvailable();

  return Response.json({
    ok: true,
    mode: gatewayAvailable ? 'gateway' : 'cli',
    hasCliSession: hasCliSession(user.id, agentId),
    sessionKey: `${user.id}:${agentId}`,
  });
}
