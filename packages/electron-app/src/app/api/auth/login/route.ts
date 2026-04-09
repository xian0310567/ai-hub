import { NextRequest } from 'next/server';
import { spawn } from 'child_process';
import { CLAUDE_CLI } from '@/lib/claude-cli';
import { getSession, getUserClaudeConfigDir } from '@/lib/auth';
import fs from 'fs';

// GET /api/auth/login — claude login 실행, URL 스트리밍
export async function GET(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const claudeConfigDir = getUserClaudeConfigDir(user.id);
  if (!fs.existsSync(claudeConfigDir)) fs.mkdirSync(claudeConfigDir, { recursive: true });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (msg: string) => controller.enqueue(encoder.encode(msg));

      send('data: {"type":"info","text":"claude login 시작중..."}\n\n');

      const isWin = process.platform === 'win32';
      const proc  = isWin
        ? spawn('powershell.exe', ['-NoProfile', '-Command', 'claude login'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir },
          })
        : spawn(CLAUDE_CLI, ['login'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir },
          });

      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');

      const handleOutput = (data: string) => {
        const lines = data.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          const urlMatch = line.match(/https?:\/\/[^\s]+/);
          if (urlMatch) {
            send(`data: ${JSON.stringify({ type: 'url', url: urlMatch[0], text: line.trim() })}\n\n`);
          } else {
            send(`data: ${JSON.stringify({ type: 'log', text: line.trim() })}\n\n`);
          }
        }
      };

      proc.stdout.on('data', handleOutput);
      proc.stderr.on('data', handleOutput);

      proc.on('close', (code) => {
        send(`data: ${JSON.stringify({ type: 'done', code })}\n\n`);
        try { controller.close(); } catch {}
      });

      proc.on('error', (e) => {
        send(`data: ${JSON.stringify({ type: 'error', text: e.message })}\n\n`);
        try { controller.close(); } catch {}
      });

      const t = setTimeout(() => {
        proc.kill();
        send(`data: ${JSON.stringify({ type: 'error', text: '타임아웃 (60초)' })}\n\n`);
        try { controller.close(); } catch {}
      }, 60000);
      proc.on('close', () => clearTimeout(t));
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
}
