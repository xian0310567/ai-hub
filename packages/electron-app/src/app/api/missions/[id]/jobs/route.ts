/**
 * GET /api/missions/[id]/jobs — 미션의 잡 목록 (quality_scores 포함)
 */
import { NextRequest } from 'next/server';
import { Missions, MissionJobs } from '@/lib/db';
import { getSession } from '@/lib/auth';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSession(req);
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const mission = Missions.get(id);
    if (!mission || mission.user_id !== user.id) return Response.json({ ok: false, error: '없음' }, { status: 404 });

    const jobs = MissionJobs.listByMission(id);
    return Response.json({ ok: true, jobs });
  } catch (err) {
    console.error('[GET /api/missions/:id/jobs] 오류:', err instanceof Error ? err.message : err);
    return Response.json({ ok: false, error: '잡 목록 조회 실패' }, { status: 500 });
  }
}
