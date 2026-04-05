import { execSync } from 'child_process';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

const ENV_FILE = path.join(process.env.DATA_DIR || path.join(process.cwd(), '.data'), 'auth.env');

function getStoredApiKey() {
  try {
    const line = fs.readFileSync(ENV_FILE, 'utf8').split('\n').find(l => l.startsWith('ANTHROPIC_API_KEY='));
    return line ? line.slice('ANTHROPIC_API_KEY='.length).trim() : '';
  } catch { return ''; }
}

// GET /api/auth — 로그인 상태 확인
export async function GET() {
  // 저장된 API 키 적용
  const stored = getStoredApiKey();
  if (stored) process.env.ANTHROPIC_API_KEY = stored;

  let loggedIn = false;
  try {
    execSync('claude --version', { stdio: 'ignore', timeout: 3000 });
    execSync('claude -p "hi" --output-format text', {
      timeout: 15000, stdio: 'pipe',
      env: { ...process.env },
    });
    loggedIn = true;
  } catch {}

  const hasApiKey = !!(process.env.ANTHROPIC_API_KEY || stored);
  return Response.json({
    ok: true,
    loggedIn: loggedIn || hasApiKey,
    keyHint: hasApiKey ? 'API Key' : loggedIn ? 'OAuth' : null,
  });
}

// POST /api/auth — API 키 저장
export async function POST(req: NextRequest) {
  const { apiKey } = await req.json() as { apiKey?: string };
  if (!apiKey?.startsWith('sk-')) return Response.json({ ok: false, error: 'sk-ant-... 형태의 키를 입력하세요' });
  const dir = path.dirname(ENV_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ENV_FILE, `ANTHROPIC_API_KEY=${apiKey}\n`, 'utf8');
  process.env.ANTHROPIC_API_KEY = apiKey;
  return Response.json({ ok: true });
}
