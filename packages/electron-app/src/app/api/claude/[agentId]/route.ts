import { NextRequest } from 'next/server';
import { spawn, execSync } from 'child_process';
import { Agents, Workspaces, Divisions, ChatLogs } from '@/lib/db';
import { randomUUID } from 'crypto';
import { getSession, getUserSessionsDir } from '@/lib/auth';
import path from 'path';
import fs from 'fs';

// DB에 없는 기존 에이전트용 fallback (레거시)
const LEGACY_MAP: Record<string, { name: string; workspace: string; commandName: string | null }> = {
  cofounder:      { name: '포지', workspace: 'workspace-cofounder', commandName: 'forge' },
  zesty_claw_bot: { name: '클로', workspace: 'workspace-zesty',     commandName: null },
  insta:          { name: '유나', workspace: 'workspace-insta',     commandName: null },
  quant:          { name: '퀀트', workspace: 'workspace-quant',     commandName: null },
  'quant-kr':     { name: '코스모', workspace: 'workspace-quant-kr', commandName: null },
  pod:            { name: 'POD',  workspace: 'workspace-pod',       commandName: null },
};

function getSessionsDir(userId: string): string {
  const dir = getUserSessionsDir(userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function hasSession(userId: string, agentId: string): boolean {
  try {
    return JSON.parse(fs.readFileSync(path.join(getSessionsDir(userId), `${agentId}.state`), 'utf8')).ok;
  } catch { return false; }
}
function markSession(userId: string, agentId: string) {
  fs.writeFileSync(path.join(getSessionsDir(userId), `${agentId}.state`), JSON.stringify({ ok: true, ts: Date.now() }), 'utf8');
}
function clearSession(userId: string, agentId: string) {
  try { fs.unlinkSync(path.join(getSessionsDir(userId), `${agentId}.state`)); } catch {}
}

function stripAnsi(s: string) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*[mGKHFJA-Z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '').replace(/\r/g, '');
}

function isClaudeAvailable(): boolean {
  try { execSync('claude --version', { stdio: 'ignore', timeout: 3000 }); return true; } catch { return false; }
}

function runClaude(
  cwd: string,
  commandName: string | null,
  message: string,
  userId: string,
  agentId: string,
  isLead = false,
  onDone?: (full: string) => void,
  model?: string | null,
): ReadableStream {
  const isFirst = !hasSession(userId, agentId);
  const prompt  = message;
  const toolArgs = isLead ? ['--allowedTools', 'Task'] : [];
  const modelArgs = model ? ['--model', model] : [];
  const args    = isFirst
    ? ['-p', prompt, ...toolArgs, ...modelArgs]
    : ['--continue', '-p', prompt, ...toolArgs, ...modelArgs];
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      const isWin = process.platform === 'win32';
      const proc  = isWin
        ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `claude ${args.map(a => `"${a.replace(/"/g, '""')}"`).join(' ')}`
          ], { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn('claude', args, { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });

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
        if (code === 0) { markSession(userId, agentId); onDone?.(full.trim()); }
        else controller.enqueue(encoder.encode(`\n[종료 코드: ${code}]`));
        try { controller.close(); } catch {}
      });

      proc.on('error', (e) => {
        controller.enqueue(encoder.encode(
          `[claude CLI 오류: ${e.message}]\n\n` +
          `claude가 설치되어 있지 않거나 로그인이 필요합니다.\n` +
          `터미널에서 'claude login'을 실행해주세요.`
        ));
        try { controller.close(); } catch {}
      });

      const t = setTimeout(() => {
        proc.kill();
        try { controller.enqueue(encoder.encode('\n[90초 타임아웃]')); controller.close(); } catch {}
      }, 90000);
      proc.on('close', () => clearTimeout(t));
    },
  });
}

// ── POST /api/claude/[agentId] ───────────────────────────────────────
export async function POST(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { agentId } = await params;
  const { message, reset } = await req.json() as { message?: string; reset?: boolean };

  if (reset) {
    clearSession(user.id, agentId);
    ChatLogs.clear(user.id, agentId);
    return Response.json({ ok: true });
  }

  if (!message) return Response.json({ ok: false, error: 'message required' }, { status: 400 });

  // 사용자 메시지 저장
  ChatLogs.add({ id: randomUUID(), user_id: user.id, agent_id: agentId, role: 'user', content: message });

  if (!isClaudeAvailable()) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('❌ claude CLI가 설치되어 있지 않습니다.\n\nnpm install -g @anthropic-ai/claude-code 으로 설치 후 claude login 을 실행해주세요.'));
        c.close();
      }
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  const agent = Agents.get(agentId);
  const legacy = LEGACY_MAP[agentId];

  let cwdPath: string;
  let commandName: string | null;
  let isLead = false;

  if (agent) {
    if (agent.user_id !== user.id) return Response.json({ ok: false, error: '권한 없음' }, { status: 403 });
    const ws = Workspaces.get(agent.workspace_id);
    if (ws) {
      cwdPath = ws.path;
    } else {
      // division-level agents store division.id in workspace_id
      const div = Divisions.get(agent.workspace_id);
      if (!div) return Response.json({ ok: false, error: '워크스페이스를 찾을 수 없습니다' }, { status: 404 });
      cwdPath = div.ws_path;
    }
    commandName = agent.command_name;
    isLead = agent.is_lead === 1;
  } else if (legacy) {
    const base = path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw');
    cwdPath = path.join(base, legacy.workspace);
    commandName = legacy.commandName;
  } else {
    return Response.json({ ok: false, error: '에이전트를 찾을 수 없습니다' }, { status: 404 });
  }

  const saveLog = (full: string) => {
    try { ChatLogs.add({ id: randomUUID(), user_id: user.id, agent_id: agentId, role: 'assistant', content: full }); } catch {}
  };

  return new Response(runClaude(cwdPath, commandName, message, user.id, agentId, isLead, saveLog, agent?.model), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    },
  });
}

// ── GET /api/claude/[agentId] — 세션 상태 ───────────────────────────
export async function GET(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { agentId } = await params;
  return Response.json({ ok: true, hasSession: hasSession(user.id, agentId) });
}
