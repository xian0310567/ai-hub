import { NextRequest } from 'next/server';
import { Missions, MissionJobs } from '@/lib/db';
import { getSession } from '@/lib/auth';

interface Step {
  org_name: string;
  agent_name: string;
  status: 'queued' | 'waiting' | 'running' | 'done' | 'failed';
  queue_position?: number;
  output?: string;
  error?: string;
}

interface Progress {
  total: number;
  completed: number;
  running: number;
  pending: number;
}

// GET /api/missions/[id]/status — 미션 진행 상태 조회
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSession(req);
  if (!user) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const mission = Missions.get(id);

  if (!mission) {
    return Response.json({ ok: false, error: '미션을 찾을 수 없습니다' }, { status: 404 });
  }

  if (mission.user_id !== user.id) {
    return Response.json({ ok: false, error: '권한이 없습니다' }, { status: 403 });
  }

  // steps 파싱 — routing 메타 객체(object)와 실행 Step[] 배열 모두 처리
  let steps: Step[] = [];
  try {
    const parsed = JSON.parse(mission.steps || '[]');
    steps = Array.isArray(parsed) ? parsed : [];
  } catch {
    steps = [];
  }

  // 큐 위치 업데이트 (실시간 반영)
  const jobs = MissionJobs.listByMission(id);
  steps = steps.map((step, idx) => {
    const job = jobs[idx];
    if (!job) return step;

    // 현재 큐 상태 확인
    if (step.status === 'waiting' || step.status === 'queued') {
      const queue = MissionJobs.queueForAgent(job.agent_id);
      const pos = queue.findIndex(j => j.id === job.id);
      const running = MissionJobs.runningForAgent(job.agent_id);

      return {
        ...step,
        status: (running || pos > 0) ? 'waiting' as const : 'queued' as const,
        queue_position: pos >= 0 ? pos : 0,
      };
    }

    return step;
  });

  // progress 계산
  const progress: Progress = {
    total: steps.length,
    completed: steps.filter(s => s.status === 'done').length,
    running: steps.filter(s => s.status === 'running').length,
    pending: steps.filter(s => s.status === 'queued' || s.status === 'waiting').length,
  };

  return Response.json({
    ok: true,
    mission: {
      id: mission.id,
      task: mission.task,
      status: mission.status,
      steps,
      progress,
    },
  });
}
