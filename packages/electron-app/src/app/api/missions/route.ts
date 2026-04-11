import { NextRequest } from 'next/server';
import { Missions, Notifications, MissionSchedules } from '@/lib/db';
import { getSession, getVmSessionCookie } from '@/lib/auth';
import { CLAUDE_CLI, CLAUDE_ENV, claudeSpawnError } from '@/lib/claude-cli';
import cronParser from 'cron-parser';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const VM_URL = process.env.VM_SERVER_URL || 'http://localhost:4000';
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_IMAGE_COUNT = 5;
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MIME_TO_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

// ── vm-server에서 조직도 가져오기 ─────────────────────────────────────
async function safeFetch(url: string, headers: Record<string, string>): Promise<any[]> {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    // 네트워크 오류 (ECONNREFUSED 등) 시 빈 배열 반환
    return [];
  }
}

async function fetchOrgData(cookie: string) {
  const headers = { 'Content-Type': 'application/json', Cookie: cookie };
  const [divisions, workspaces, teams, parts, agents] = await Promise.all([
    safeFetch(`${VM_URL}/api/divisions`, headers),
    safeFetch(`${VM_URL}/api/workspaces`, headers),
    safeFetch(`${VM_URL}/api/teams`, headers),
    safeFetch(`${VM_URL}/api/parts`, headers),
    safeFetch(`${VM_URL}/api/agents`, headers),
  ]);
  return { divisions, workspaces, teams, parts, agents };
}

// ── 조직도 텍스트 빌드 ────────────────────────────────────────────────
function buildOrgChart(org: Awaited<ReturnType<typeof fetchOrgData>>): string {
  const { divisions, workspaces, teams, parts, agents } = org;
  const lines: string[] = [];

  // 부문 소속 workspace id 집합
  const divWorkspaceIds = (divId: string) =>
    new Set(workspaces.filter((w: any) => w.division_id === divId).map((w: any) => w.id));

  for (const div of divisions) {
    // 부문 리더: org_level==='division' 이고 소속 workspace가 이 부문에 속하는 에이전트
    const divWsIds = divWorkspaceIds(div.id);
    const divLead = agents.find((a: any) => a.org_level === 'division' && divWsIds.has(a.workspace_id));
    lines.push(`◉ 부문: ${div.name} (id: ${div.id})`);
    if (divLead) lines.push(`  리더: ${divLead.emoji} ${divLead.name} (agent_id: ${divLead.id})`);

    const depts = workspaces.filter((w: any) => w.division_id === div.id);
    for (const dept of depts) {
      const deptLead = agents.find((a: any) => a.org_level === 'department' && a.workspace_id === dept.id);
      lines.push(`  🏢 실: ${dept.name} (id: ${dept.id})`);
      if (deptLead) lines.push(`    리더: ${deptLead.emoji} ${deptLead.name} (agent_id: ${deptLead.id})`);

      const deptTeams = teams.filter((t: any) => t.workspace_id === dept.id);
      for (const team of deptTeams) {
        const teamLead = agents.find((a: any) => a.team_id === team.id && a.is_lead === 1);
        const workers  = agents.filter((a: any) => a.team_id === team.id && a.is_lead === 0 && !a.part_id);
        lines.push(`    ▸ 팀: ${team.name} (id: ${team.id})${team.description ? ' — ' + team.description : ''}`);
        if (teamLead) lines.push(`      리더: ${teamLead.emoji} ${teamLead.name} (agent_id: ${teamLead.id})`);
        for (const w of workers) lines.push(`      팀원: ${w.emoji} ${w.name} (agent_id: ${w.id})`);

        const teamParts = parts.filter((p: any) => p.team_id === team.id);
        for (const part of teamParts) {
          const pLead    = agents.find((a: any) => a.part_id === part.id && a.is_lead === 1);
          const pWorkers = agents.filter((a: any) => a.part_id === part.id && a.is_lead === 0);
          lines.push(`      ◆ 파트: ${part.name} (id: ${part.id})`);
          if (pLead) lines.push(`        리더: ${pLead.emoji} ${pLead.name} (agent_id: ${pLead.id})`);
          for (const w of pWorkers) lines.push(`        팀원: ${w.emoji} ${w.name} (agent_id: ${w.id})`);
        }
      }
    }
  }

  // 독립 실
  for (const dept of workspaces.filter((w: any) => !w.division_id)) {
    const deptLead = agents.find((a: any) => a.org_level === 'department' && a.workspace_id === dept.id);
    lines.push(`🏢 독립 실: ${dept.name} (id: ${dept.id})`);
    if (deptLead) lines.push(`  리더: ${deptLead.emoji} ${deptLead.name} (agent_id: ${deptLead.id})`);
    for (const team of teams.filter((t: any) => t.workspace_id === dept.id)) {
      const teamLead = agents.find((a: any) => a.team_id === team.id && a.is_lead === 1);
      lines.push(`  ▸ 팀: ${team.name} (id: ${team.id})`);
      if (teamLead) lines.push(`    리더: ${teamLead.emoji} ${teamLead.name} (agent_id: ${teamLead.id})`);
    }
  }

  return lines.join('\n');
}

// ── 이미지 유틸 ───────────────────────────────────────────────────────
function detectMimeType(b64: string): string | null {
  const sigs: Record<string, string> = { '/9j/': 'image/jpeg', 'iVBORw0KGgo': 'image/png', 'R0lGOD': 'image/gif', 'UklGR': 'image/webp' };
  for (const [sig, mime] of Object.entries(sigs)) if (b64.startsWith(sig)) return mime;
  return null;
}

async function saveImages(userId: string, missionId: string, images: string[]) {
  if (images.length > MAX_IMAGE_COUNT) throw new Error(`최대 ${MAX_IMAGE_COUNT}개까지 업로드 가능합니다`);
  if ([userId, missionId].some(v => !v || v.includes('..') || v.includes('/'))) throw new Error('잘못된 ID');

  const dir = path.join(process.env.DATA_DIR || path.join(process.cwd(), '.data'), 'users', userId, 'missions', missionId, 'images');
  fs.mkdirSync(dir, { recursive: true });

  const saved: { path: string; filename: string; size: number }[] = [];
  const ts = Date.now();

  for (let i = 0; i < images.length; i++) {
    let b64 = images[i];
    let mime: string | null = null;
    const match = b64.match(/^data:([^;]+);base64,(.+)$/);
    if (match) { mime = match[1]; b64 = match[2]; } else { mime = detectMimeType(b64); }
    if (!mime || !ALLOWED_MIME_TYPES.includes(mime)) throw new Error('지원하지 않는 이미지 형식');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > MAX_IMAGE_SIZE) throw new Error(`이미지 크기 초과 (최대 ${MAX_IMAGE_SIZE / 1024 / 1024}MB)`);
    const filename = `${ts}_${i}.${MIME_TO_EXT[mime]}`;
    fs.writeFileSync(path.join(dir, filename), buf);
    saved.push({ path: path.join(dir, filename), filename, size: buf.length });
  }
  return saved;
}

// ── steps 파싱 유틸 — routing 메타(object) vs 실행 Step[](array) 모두 처리 ──
function parseStepsField(raw: string | undefined): { steps: any[]; summary?: string; routingMeta?: any } {
  try {
    const parsed = JSON.parse(raw || '[]');
    if (Array.isArray(parsed)) return { steps: parsed };
    // routing 분석 결과 메타 객체 (summary, is_recurring 등)
    return { steps: [], summary: parsed.summary, routingMeta: parsed };
  } catch { return { steps: [] }; }
}

// ── GET /api/missions ─────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const user = await getSession(req);
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const missions = Missions.list(user.id).map(m => {
      const { steps, summary, routingMeta } = parseStepsField(m.steps);
      return {
        ...m,
        routing: JSON.parse(m.routing || '[]'),
        images: m.images ? JSON.parse(m.images) : [],
        steps,
        summary,
        routingMeta,
      };
    });
    return Response.json({ ok: true, missions });
  } catch (err) {
    console.error('[GET /api/missions] 오류:', err instanceof Error ? err.message : err);
    return Response.json({ ok: false, error: '미션 목록 조회 실패' }, { status: 500 });
  }
}

// ── POST /api/missions ────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const user = await getSession(req);
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const { task, images = [], parent_mission_id, origin } = await req.json() as {
      task: string; images?: string[];
      parent_mission_id?: string; origin?: string;
    };
    if (!task?.trim()) return Response.json({ ok: false, error: '미션 설명을 입력하세요' }, { status: 400 });

    const id = randomUUID();
    let savedImages: { path: string; filename: string; size: number }[] = [];

    try {
      if (images.length > 0) savedImages = await saveImages(user.id, id, images);
    } catch (err) {
      return Response.json({ ok: false, error: (err as Error).message }, { status: 400 });
    }

    // vm-server에서 조직도 가져오기
    const cookie = getVmSessionCookie(req);
    const orgData = await fetchOrgData(cookie);
    const orgChart = buildOrgChart(orgData);

    if (!orgChart.trim()) {
      return Response.json({ ok: false, error: '조직이 없습니다. 먼저 조직을 만드세요.' }, { status: 400 });
    }

    Missions.create({ id, user_id: user.id, task, routing: '[]', parent_mission_id, origin: origin ?? 'user' });
    Missions.update(id, { status: 'analyzing', images: JSON.stringify(savedImages) });

    // Claude CLI 실행 디렉토리 결정 (workspace path가 비어있거나 없으면 cwd 사용)
    const firstWsPath = orgData.workspaces[0]?.path;
    const cwd = (firstWsPath && firstWsPath.trim() && fs.existsSync(firstWsPath)) ? firstWsPath : process.cwd();
    const hasImages = savedImages.length > 0;
    const promptArgs = ['-p', buildRoutingPrompt(orgChart, task, hasImages)];
    if (hasImages) savedImages.forEach(img => promptArgs.push(img.path));

    setImmediate(() => {
      execFile(CLAUDE_CLI, promptArgs, { cwd, encoding: 'utf8', timeout: 90000, env: CLAUDE_ENV },
        (err, stdout) => {
          if (err) { Missions.update(id, { status: 'routing_failed', result: claudeSpawnError(err) }); return; }
          try {
            // Claude가 JSON 이외 텍스트를 포함하는 경우에도 파싱 시도
            let parsed: any;
            const text = stdout.trim();
            // 1차 시도: 코드 펜스 제거 후 파싱
            const cleaned = text.replace(/^```json\s*/m, '').replace(/^```\s*/m, '').replace(/\s*```\s*$/m, '').trim();
            try { parsed = JSON.parse(cleaned); } catch {
              // 2차 시도: 첫 { 부터 마지막 } 까지 추출
              const start = text.indexOf('{');
              const end = text.lastIndexOf('}');
              if (start === -1 || end === -1 || end <= start) throw new Error('JSON 없음');
              parsed = JSON.parse(text.slice(start, end + 1));
            }

            const routing = parsed.routing || [];
            if (!Array.isArray(routing) || routing.length === 0) {
              Missions.update(id, { status: 'routing_failed' }); return;
            }

            for (const orgName of (parsed.new_org_needed || [])) {
              Notifications.create({ id: randomUUID(), user_id: user.id, type: 'org_needed',
                title: `${orgName} 생성 권장`, message: `미션에서 ${orgName}이(가) 필요합니다.`, read: 0 });
            }

            Missions.update(id, {
              routing: JSON.stringify(routing),
              status: parsed.needs_clarification ? 'needs_clarification' : 'routed',
              steps: JSON.stringify({ summary: parsed.summary, needs_clarification: parsed.needs_clarification || false,
                clarification: parsed.clarification || null, new_org_needed: parsed.new_org_needed || [],
                is_recurring: parsed.is_recurring || false, schedule_name: parsed.schedule_name || null,
                cron_expr: parsed.cron_expr || null }),
            });

            // 반복 미션이면 스케줄 생성
            if (parsed.is_recurring && parsed.cron_expr && !parsed.needs_clarification) {
              try {
                const interval = cronParser.parseExpression(parsed.cron_expr);
                const nextTs = Math.floor(interval.next().getTime() / 1000);
                MissionSchedules.create({
                  id: randomUUID(),
                  user_id: user.id,
                  name: parsed.schedule_name || task.slice(0, 60),
                  cron_expr: parsed.cron_expr,
                  task,
                  routing: JSON.stringify(routing),
                  session_cookie: cookie,
                  next_run_at: nextTs,
                });
              } catch { /* cron 파싱 실패 시 스케줄 생성 생략 */ }
            }
          } catch { Missions.update(id, { status: 'routing_failed' }); }
        }
      );
    });

    return Response.json({ ok: true, mission: { id, task, status: 'analyzing', images: savedImages } });
  } catch (err) {
    console.error('[POST /api/missions] 오류:', err instanceof Error ? err.message : err);
    return Response.json({ ok: false, error: '미션 생성 중 오류가 발생했습니다' }, { status: 500 });
  }
}

// ── PATCH /api/missions ───────────────────────────────────────────────
export async function PATCH(req: NextRequest) {
  try {
    const user = await getSession(req);
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const { id, extra_routing } = await req.json();
    const m = Missions.get(id);
    if (!m || m.user_id !== user.id) return Response.json({ ok: false, error: '없음' }, { status: 404 });

    const merged = [...JSON.parse(m.routing || '[]'), ...(extra_routing || [])];
    Missions.update(id, { routing: JSON.stringify(merged), status: 'routed' });
    return Response.json({ ok: true, routing: merged });
  } catch (err) {
    console.error('[PATCH /api/missions] 오류:', err instanceof Error ? err.message : err);
    return Response.json({ ok: false, error: '미션 업데이트 실패' }, { status: 500 });
  }
}

// ── DELETE /api/missions?id=xxx ───────────────────────────────────────
export async function DELETE(req: NextRequest) {
  try {
    const user = await getSession(req);
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const id = new URL(req.url).searchParams.get('id');
    if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });

    const m = Missions.get(id);
    if (!m || m.user_id !== user.id) return Response.json({ ok: false, error: '없음' }, { status: 404 });

    const imagesDir = path.join(process.env.DATA_DIR || path.join(process.cwd(), '.data'), 'users', user.id, 'missions', id, 'images');
    if (fs.existsSync(imagesDir)) fs.rmSync(imagesDir, { recursive: true, force: true });

    Missions.delete(id);
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/missions] 오류:', err instanceof Error ? err.message : err);
    return Response.json({ ok: false, error: '미션 삭제 실패' }, { status: 500 });
  }
}

// ── 라우팅 프롬프트 ───────────────────────────────────────────────────
function buildRoutingPrompt(orgChart: string, task: string, hasImages: boolean): string {
  return `당신은 AI 조직의 미션 라우터입니다.${hasImages ? '\n\n**첨부된 이미지를 참고하여 분석하세요.**' : ''}

## 현재 조직도
${orgChart}

## 사용자 요청
${task}

반드시 아래 JSON 형식으로만 답변하세요:
{
  "summary": "미션 요약 (1문장)",
  "routing": [{"org_id":"...","org_type":"team","org_name":"...","agent_id":"...","agent_name":"...","subtask":"...","approach":"...","deliverables":[],"gate_type":"auto"}],
  "needs_clarification": false,
  "clarification": null,
  "new_org_needed": [],
  "is_recurring": false,
  "cron_expr": null,
  "schedule_name": null
}

gate_type 판단 기준:
- 기본값은 "auto" (자동 실행)
- 외부 발송(이메일·슬랙·SNS 게시), 결제·환불, 데이터 삭제·초기화, 외부 API 쓰기 등 되돌리기 어려운 작업은 "human"으로 설정
- "human"으로 설정된 잡은 에이전트 실행 전 담당자 승인이 필요함

is_recurring 판단 기준:
- 사용자 요청에 "매일", "매주", "매월", "정기적으로", "자동으로", "반복", "every", "daily", "weekly" 등의 반복 의도가 있으면 true
- is_recurring이 true면 cron_expr에 표준 5필드 cron 표현식 작성 (예: "0 9 * * 1-5" = 평일 오전 9시)
- schedule_name은 이 스케줄의 짧은 이름 (예: "일일 리포트", "주간 요약")
- 반복 의도가 없으면 세 필드 모두 기본값 유지`;
}
