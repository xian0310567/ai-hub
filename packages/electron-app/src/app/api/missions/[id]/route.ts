import { NextRequest } from 'next/server';
import { Missions } from '@/lib/db';
import { getSession } from '@/lib/auth';

// GET /api/missions/[id] — 미션 상세 조회
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const mission = Missions.get(id);
  if (!mission || mission.user_id !== user.id) {
    return Response.json({ ok: false, error: '미션 없음' }, { status: 404 });
  }

  return Response.json({
    ok: true,
    mission: {
      ...mission,
      routing: JSON.parse(mission.routing || '[]'),
      steps: JSON.parse(mission.steps || '[]'),
    },
  });
}
