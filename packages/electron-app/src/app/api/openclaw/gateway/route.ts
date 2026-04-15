/**
 * OpenClaw Gateway 관리 API
 *
 * GET  /api/openclaw/gateway — 상태 조회
 * POST /api/openclaw/gateway — 시작/정지 제어
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { getGatewayInfo, startGateway, stopGateway, getLogBuffer, clearLogBuffer } from '@/lib/gateway-manager';
import { getSetupStatus } from '@/lib/openclaw-config';

export async function GET(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const info = await getGatewayInfo();
  const setupStatus = getSetupStatus();
  const withLogs = new URL(req.url).searchParams.get('logs') === '1';
  return Response.json({
    ok: true,
    ...info,
    cliBackendConfigured: setupStatus.isConfigured,
    ...(withLogs ? { logs: getLogBuffer() } : {}),
  });
}

export async function POST(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { action } = await req.json() as { action: 'start' | 'stop' };

  if (action === 'start') {
    const result = await startGateway(true);
    return Response.json({ ok: result.ok, reason: result.reason, detail: result.detail });
  }

  if (action === 'stop') {
    stopGateway();
    return Response.json({ ok: true });
  }

  if (action === 'clear-logs') {
    clearLogBuffer();
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: 'Invalid action' }, { status: 400 });
}
