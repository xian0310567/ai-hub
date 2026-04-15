import { NextRequest } from 'next/server';
import { Missions, MissionJobs } from '@/lib/db';
import { getSession } from '@/lib/auth';

// PATCH /api/missions/[id]/jobs/[jobId]/approve — Human Gate 승인
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  try {
    const user = await getSession(req);
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const { id, jobId } = await params;

    const mission = Missions.get(id);
    if (!mission || mission.user_id !== user.id)
      return Response.json({ ok: false, error: '미션 없음' }, { status: 404 });

    const job = MissionJobs.get(jobId);
    if (!job || job.mission_id !== id)
      return Response.json({ ok: false, error: '잡 없음' }, { status: 404 });

    if (job.gate_type !== 'human')
      return Response.json({ ok: false, error: 'Human Gate 잡이 아님' }, { status: 400 });

    if (job.status !== 'gate_pending')
      return Response.json({ ok: false, error: `승인 대기 상태가 아님 (현재: ${job.status})` }, { status: 409 });

    MissionJobs.approve(jobId);
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[PATCH /api/missions/:id/jobs/:jobId/approve] 오류:', err instanceof Error ? err.message : err);
    return Response.json({ ok: false, error: '승인 처리 실패' }, { status: 500 });
  }
}
