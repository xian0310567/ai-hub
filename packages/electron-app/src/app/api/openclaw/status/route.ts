/**
 * OpenClaw 통합 상태 API
 *
 * GET /api/openclaw/status
 * - Gateway 연결 상태
 * - DB 동기화 상태
 * - 에이전트 수
 */

import { NextRequest } from 'next/server';
import { getSession, getVmSessionCookie } from '@/lib/auth';
import { getGatewayStatus } from '@/lib/openclaw-client';

const VM_URL = process.env.VM_SERVER_URL || 'http://localhost:4000';

export async function GET(req: NextRequest) {
  const user = await getSession(req);
  if (!user) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const cookie = getVmSessionCookie(req);

  // Gateway 상태와 DB 동기화 상태를 병렬 조회
  const [gateway, dbStatus] = await Promise.all([
    getGatewayStatus(),
    fetchDbStatus(cookie),
  ]);

  return Response.json({
    ok: true,
    gateway,
    db: dbStatus,
  });
}

async function fetchDbStatus(cookie: string) {
  try {
    const res = await fetch(`${VM_URL}/api/openclaw/status`, {
      headers: { Cookie: cookie },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
