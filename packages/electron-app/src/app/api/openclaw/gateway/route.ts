/**
 * OpenClaw Gateway 관리 API
 *
 * GET  /api/openclaw/gateway — 상태 조회
 * POST /api/openclaw/gateway — 시작/정지 제어
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { getGatewayInfo, startGateway, stopGateway } from '@/lib/gateway-manager';

export async function GET(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const info = await getGatewayInfo();
  return Response.json({ ok: true, ...info });
}

export async function POST(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { action } = await req.json() as { action: 'start' | 'stop' };

  if (action === 'start') {
    const result = await startGateway();
    return Response.json({ ok: result.ok, reason: result.reason });
  }

  if (action === 'stop') {
    stopGateway();
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: 'Invalid action' }, { status: 400 });
}
