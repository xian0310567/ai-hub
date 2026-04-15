import { NextRequest } from 'next/server';
import { proxyToVm, proxyBodyToVm, getVmCookie } from '@/lib/vm-proxy';
import { NextResponse } from 'next/server';
import { MissionSchedules } from '@/lib/db';
import { getSession } from '@/lib/auth';

const VM_URL = process.env.VM_SERVER_URL || 'http://localhost:4000';

export async function GET(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // vm-server 스케줄 조회
  const vmRes = await proxyToVm(req, '/api/schedules');
  let vmSchedules: any[] = [];
  try {
    const body = await vmRes.json();
    if (Array.isArray(body)) vmSchedules = body;
  } catch { /* vm-server 응답 파싱 실패 시 빈 배열 */ }

  // 로컬 mission_schedules 조회
  const localSchedules = MissionSchedules.list(user.id);

  // vm-server 스케줄 ID 집합 (중복 방지)
  const vmIds = new Set(vmSchedules.map(s => s.id));

  const merged = [
    ...vmSchedules.map(s => ({ ...s, source: 'vm' })),
    ...localSchedules
      .filter(s => !vmIds.has(s.id))
      .map(s => ({
        id: s.id,
        name: s.name,
        cron_expr: s.cron_expr,
        payload: JSON.stringify({ task: s.task }),
        enabled: !!s.enabled,
        last_run_at: s.last_run_at,
        next_run_at: s.next_run_at,
        created_at: s.created_at,
        source: 'local',
      })),
  ];

  return NextResponse.json(merged);
}

export async function POST(req: NextRequest) {
  return proxyBodyToVm(req, '/api/schedules', 'POST');
}

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { id, source } = body as { id?: string; source?: string };

  if (source === 'local' && id) {
    const user = await getSession(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const sched = MissionSchedules.get(id);
    if (!sched || sched.user_id !== user.id) {
      return NextResponse.json({ error: '없음' }, { status: 404 });
    }

    const { name, cron_expr, enabled } = body as {
      name?: string; cron_expr?: string; enabled?: boolean;
    };

    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (enabled !== undefined) updates.enabled = enabled ? 1 : 0;
    if (cron_expr !== undefined) {
      try {
        const cronParser = await import('cron-parser');
        const interval = cronParser.default
          ? cronParser.default.parseExpression(cron_expr)
          : (cronParser as any).parseExpression(cron_expr);
        updates.cron_expr = cron_expr;
        updates.next_run_at = Math.floor(interval.next().getTime() / 1000);
      } catch {
        return NextResponse.json({ error: '잘못된 cron 표현식' }, { status: 400 });
      }
    }

    if (Object.keys(updates).length > 0) {
      MissionSchedules.update(id, updates);
    }

    const updated = MissionSchedules.get(id);
    return NextResponse.json({
      ...updated,
      payload: JSON.stringify({ task: updated?.task }),
      enabled: !!updated?.enabled,
      source: 'local',
    });
  }

  // vm-server로 프록시
  return proxyBodyToVm(req, '/api/schedules', 'PATCH', body);
}

export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const source = url.searchParams.get('source');

  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  if (source === 'local') {
    const user = await getSession(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const sched = MissionSchedules.get(id);
    if (!sched || sched.user_id !== user.id) {
      return NextResponse.json({ error: '없음' }, { status: 404 });
    }

    MissionSchedules.delete(id);
    return NextResponse.json({ ok: true });
  }

  // vm-server로 프록시
  const cookie = getVmCookie(req);
  const vmRes = await fetch(`${VM_URL}/api/schedules`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ id }),
  });

  const body = await vmRes.json().catch(() => ({}));
  return NextResponse.json(body, { status: vmRes.status });
}
