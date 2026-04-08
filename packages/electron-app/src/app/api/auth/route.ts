import { execSync } from 'child_process';
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';

// GET /api/auth — claude 연결 상태 확인
export async function GET(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  let loggedIn = false;
  try {
    execSync('claude --version', { stdio: 'ignore', timeout: 3000 });
    execSync('claude -p "1+1=" --output-format text', {
      timeout: 15000,
      stdio: 'pipe',
      env: { ...process.env },
    });
    loggedIn = true;
  } catch {}

  return Response.json({ ok: true, loggedIn, keyHint: loggedIn ? 'OAuth' : null });
}
