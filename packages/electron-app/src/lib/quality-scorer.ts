/**
 * 미션 잡 품질 자동 채점기
 * 5개 차원: quality(품질), completeness(완성도), accuracy(정확도), timeliness(신속성), collaboration(협업)
 * 잡 완료 후 fire-and-forget으로 호출; 평균 65 미만 시 알림 생성
 */
import { MissionJobs, Notifications } from './db';
import { randomUUID } from 'crypto';

export interface QualityScores {
  quality:       number; // 출력물 품질 (0-100)
  completeness:  number; // 태스크 완성도
  accuracy:      number; // 정확도/신뢰성
  timeliness:    number; // 처리 속도 (소요 시간 기반)
  collaboration: number; // 협업 기여도 (서브태스크 명확성)
  average:       number; // 평균
}

/**
 * 출력 결과물 텍스트에서 5개 차원 휴리스틱 채점
 */
function scoreResult(result: string, subtask: string, durationMs: number): QualityScores {
  const len = result.length;

  // 1. quality: 결과물 길이 + 마크다운 구조 + 코드블록 포함 여부
  const hasHeaders    = /^#{1,3} /m.test(result);
  const hasCodeBlock  = /```/.test(result);
  const hasList       = /^[-*] /m.test(result);
  const lengthScore   = Math.min(100, (len / 800) * 60);
  const structScore   = (hasHeaders ? 15 : 0) + (hasCodeBlock ? 15 : 0) + (hasList ? 10 : 0);
  const quality       = Math.min(100, Math.round(lengthScore + structScore));

  // 2. completeness: 결과가 비어 있지 않고 error 없음, 단어 수 기반
  const words        = result.trim().split(/\s+/).length;
  const hasError     = /error|exception|failed|실패/i.test(result);
  const completeness = result.trim().length === 0 ? 0
    : hasError ? Math.max(20, Math.round((words / 200) * 60))
    : Math.min(100, Math.round((words / 200) * 100));

  // 3. accuracy: 서브태스크 키워드가 결과에 포함되는 비율
  const taskWords  = subtask.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const matched    = taskWords.filter(w => result.toLowerCase().includes(w)).length;
  const accuracy   = taskWords.length === 0 ? 70
    : Math.round((matched / taskWords.length) * 100);

  // 4. timeliness: 소요 시간 기반 (60s 이하=100, 300s=50, 600s+=10)
  const secs       = durationMs / 1000;
  const timeliness = secs <= 60  ? 100
    : secs <= 300 ? Math.round(100 - ((secs - 60) / 240) * 50)
    : secs <= 600 ? Math.round(50  - ((secs - 300) / 300) * 40)
    : 10;

  // 5. collaboration: 서브태스크가 구체적이면 높은 점수
  const taskLen      = subtask.trim().length;
  const collaboration = taskLen < 20 ? 40
    : taskLen < 80  ? 70
    : taskLen < 200 ? 85
    : 95;

  const average = Math.round((quality + completeness + accuracy + timeliness + collaboration) / 5);

  return { quality, completeness, accuracy, timeliness, collaboration, average };
}

/**
 * 잡 완료 후 호출 — fire-and-forget (await 없이 사용)
 */
export async function scoreJob(jobId: string, userId: string): Promise<void> {
  try {
    const job = MissionJobs.get(jobId);
    if (!job) return;

    const durationMs = job.started_at && job.finished_at
      ? (job.finished_at - job.started_at) * 1000
      : 30_000;

    const scores = scoreResult(job.result, job.subtask, durationMs);
    MissionJobs.setQualityScores(jobId, JSON.stringify(scores));

    if (scores.average < 65) {
      Notifications.create({
        id:      randomUUID(),
        user_id: userId,
        type:    'warning',
        title:   `품질 경고: ${job.agent_name}`,
        message: `잡 #${jobId.slice(0, 8)} 평균 품질 점수 ${scores.average}점 (기준 65점 미달)`,
      });
    }
  } catch {
    // 채점 실패는 무시
  }
}
