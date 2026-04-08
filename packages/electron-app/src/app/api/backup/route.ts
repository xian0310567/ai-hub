/**
 * 백업 API 프록시
 * GET  — 백업 목록 조회
 * POST — SQLite 즉시 백업 실행
 */
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
const VM_URL   = process.env.VM_SERVER_URL || 'http://localhost:4000';

function getVmCookie(req: NextRequest): string {
  const vmSession = req.cookies?.get?.('vm_session')?.value
    ?? req.headers.get('cookie')?.match(/vm_session=([^;]+)/)?.[1]
    ?? '';
  return vmSession ? `session=${vmSession}` : '';
}

export async function GET(req: NextRequest) {
  const cookie = getVmCookie(req);
  try {
    const res = await fetch(`${VM_URL}/api/backup/sqlite`, {
      headers: { Cookie: cookie },
    });
    const data = await res.json();
    return Response.json(data);
  } catch {
    return Response.json({ ok: false, error: 'vm-server 연결 실패' }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const cookie = getVmCookie(req);
  const dbPath = path.join(DATA_DIR, 'local.db');

  if (!fs.existsSync(dbPath))
    return Response.json({ ok: false, error: '로컬 DB가 없습니다' }, { status: 404 });

  try {
    const buf = fs.readFileSync(dbPath);
    const res = await fetch(`${VM_URL}/api/backup/sqlite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Cookie: cookie },
      body: buf,
    });
    const data = await res.json();
    return Response.json(data);
  } catch {
    return Response.json({ ok: false, error: '백업 전송 실패' }, { status: 503 });
  }
}
