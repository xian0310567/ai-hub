import { NextRequest } from 'next/server';
import { spawn, execSync } from 'child_process';
import { Agents, Workspaces } from '@/lib/db';
import path from 'path';

// DB에 없는 기존 에이전트용 fallback
const LEGACY_MAP: Record<string, { name: string; workspace: string; commandName: string | null }> = {
  cofounder:      { name: '포지', workspace: 'workspace-cofounder', commandName: 'forge' },
  zesty_claw_bot: { name: '클로', workspace: 'workspace-zesty',     commandName: null },
  insta:          { name: '유나', workspace: 'workspace-insta',     commandName: null },
  quant:          { name: '퀀트', workspace: 'workspace-quant',     commandName: null },
  'quant-kr':     { name: '코스모', workspace: 'workspace-quant-kr', commandName: null },
  pod:            { name: 'POD',  workspace: 'workspace-pod',       commandName: null },
};
import fs from 'fs';

const SESSIONS_DIR = path.join(process.cwd(), '.data', 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ── 세션 상태 (claude --continue 추적) ──────────────────────────────
function hasSession(agentId: string): boolean {
  try { return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${agentId}.state`), 'utf8')).ok; } catch { return false; }
}
function markSession(agentId: string) {
  fs.writeFileSync(path.join(SESSIONS_DIR, `${agentId}.state`), JSON.stringify({ ok: true, ts: Date.now() }), 'utf8');
}
function clearSession(agentId: string) {
  try { fs.unlinkSync(path.join(SESSIONS_DIR, `${agentId}.state`)); } catch {}
}

// ANSI 코드 제거
function stripAnsi(s: string) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*[mGKHFJA-Z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '').replace(/\r/g, '');
}

// claude CLI 실행 여부 확인
function isClaudeAvailable(): boolean {
  try { execSync('claude --version', { stdio: 'ignore', timeout: 3000 }); return true; } catch { return false; }
}

// ── claude CLI 실행 → 스트리밍 ───────────────────────────────────────
function runClaude(cwd: string, commandName: string | null, message: string, agentId: string, isLead = false): ReadableStream {
  const isFirst = !hasSession(agentId);
  const prompt  = isFirst && commandName ? `/${commandName} ${message}` : message;
  // 팀장(lead)이면 Task 툴 허용 → 서브에이전트 실제 소환
  const toolArgs = isLead ? ['--allowedTools', 'Task'] : [];
  const args    = isFirst
    ? ['-p', prompt, ...toolArgs]
    : ['--continue', '-p', prompt, ...toolArgs];
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
      let buf = '';
      proc.stdout.on('data', (chunk: string) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const l of lines) controller.enqueue(encoder.encode(stripAnsi(l) + '\n'));
      });

      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (c: string) => {
        const t = stripAnsi(c);
        if (t.toLowerCase().includes('error') && !t.includes('✓')) {
          controller.enqueue(encoder.encode(`[!] ${t}`));
        }
      });

      proc.on('close', (code) => {
        if (buf) controller.enqueue(encoder.encode(stripAnsi(buf)));
        if (code === 0) markSession(agentId);
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
  const { agentId } = await params;
  const { message, reset } = await req.json() as { message?: string; reset?: boolean };

  if (reset) {
    clearSession(agentId);
    return Response.json({ ok: true });
  }

  if (!message) return Response.json({ ok: false, error: 'message required' }, { status: 400 });

  // claude CLI 체크
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

  // DB에서 에이전트 조회, 없으면 legacy fallback
  const agent = Agents.get(agentId);
  const legacy = LEGACY_MAP[agentId];

  let cwdPath: string;
  let commandName: string | null;

  let isLead = false;
  if (agent) {
    const ws = Workspaces.get(agent.workspace_id);
    if (!ws) return Response.json({ ok: false, error: '워크스페이스를 찾을 수 없습니다' }, { status: 404 });
    cwdPath = ws.path;
    commandName = agent.command_name;
    isLead = agent.is_lead === 1;
  } else if (legacy) {
    const base = path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw');
    cwdPath = path.join(base, legacy.workspace);
    commandName = legacy.commandName;
  } else {
    return Response.json({ ok: false, error: '에이전트를 찾을 수 없습니다' }, { status: 404 });
  }

  return new Response(runClaude(cwdPath, commandName, message, agentId, isLead), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    },
  });
}

// ── GET /api/claude/[agentId] — 세션 상태 ───────────────────────────
export async function GET(_req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  return Response.json({ ok: true, hasSession: hasSession(agentId) });
}
