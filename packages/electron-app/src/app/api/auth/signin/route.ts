import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const VM_URL = process.env.VM_SERVER_URL || 'http://localhost:4000';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
const SESSION_FILE = path.join(DATA_DIR, 'daemon-session.json');

export async function POST(req: NextRequest) {
  const body = await req.json();

  const vmRes = await fetch(`${VM_URL}/api/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await vmRes.json();
  const res = NextResponse.json(data, { status: vmRes.status });

  if (vmRes.ok) {
    // vm-server의 session 쿠키를 vm_session으로 중계
    const setCookie = vmRes.headers.get('set-cookie');
    const match = setCookie?.match(/session=([^;]+)/);
    if (match) {
      const sessionId = match[1];

      res.cookies.set('vm_session', sessionId, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 30,
        path: '/',
      });

      // 데몬이 읽을 수 있도록 로컬 파일에도 저장
      try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(SESSION_FILE, JSON.stringify({ session: sessionId, updated_at: Date.now() }), 'utf8');
      } catch {}
    }
  }

  return res;
}
