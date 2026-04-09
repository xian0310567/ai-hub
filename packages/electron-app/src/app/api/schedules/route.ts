import { NextRequest } from 'next/server';
import { MissionSchedules } from '@/lib/db';
import { getSession } from '@/lib/auth';
import { randomUUID } from 'crypto';
import cronParser from 'cron-parser';

// GET /api/schedules — 내 스케줄 목록
export async function GET(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const schedules = MissionSchedules.list(user.id);
  return Response.json({ ok: true, schedules });
}

// PATCH /api/schedules — 스케줄 활성화/비활성화 또는 cron 수정
export async function PATCH(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { id, enabled, cron_expr, name } = await req.json() as {
    id: string; enabled?: boolean; cron_expr?: string; name?: string;
  };
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });

  const sched = MissionSchedules.get(id);
  if (!sched || sched.user_id !== user.id)
    return Response.json({ ok: false, error: '없음' }, { status: 404 });

  if (enabled !== undefined) MissionSchedules.setEnabled(id, enabled);
  if (name !== undefined) MissionSchedules.update(id, { name });
  if (cron_expr !== undefined) {
    try {
      const interval = cronParser.parseExpression(cron_expr);
      const nextTs = Math.floor(interval.next().getTime() / 1000);
      MissionSchedules.update(id, { cron_expr, next_run_at: nextTs });
    } catch {
      return Response.json({ ok: false, error: '잘못된 cron 표현식' }, { status: 400 });
    }
  }

  return Response.json({ ok: true, schedule: MissionSchedules.get(id) });
}

// DELETE /api/schedules?id=xxx — 스케줄 삭제
export async function DELETE(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });

  const sched = MissionSchedules.get(id);
  if (!sched || sched.user_id !== user.id)
    return Response.json({ ok: false, error: '없음' }, { status: 404 });

  MissionSchedules.delete(id);
  return Response.json({ ok: true });
}
