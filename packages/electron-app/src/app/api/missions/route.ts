import { NextRequest } from 'next/server';
import { Missions, Notifications } from '@/lib/db';
import { getSession, getVmSessionCookie } from '@/lib/auth';
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
async function fetchOrgData(cookie: string) {
  const headers = { 'Content-Type': 'application/json', Cookie: cookie };
  const [divisionsRes, workspacesRes, teamsRes, partsRes, agentsRes] = await Promise.all([
    fetch(`${VM_URL}/api/divisions`, { headers }),
    fetch(`${VM_URL}/api/workspaces`, { headers }),
    fetch(`${VM_URL}/api/teams`, { headers }),
    fetch(`${VM_URL}/api/parts`, { headers }),
    fetch(`${VM_URL}/api/agents`, { headers }),
  ]);
  return {
    divisions:  divisionsRes.ok  ? await divisionsRes.json()  : [],
    workspaces: workspacesRes.ok ? await workspacesRes.json() : [],
    teams:      teamsRes.ok      ? await teamsRes.json()      : [],
    parts:      partsRes.ok      ? await partsRes.json()      : [],
    agents:     agentsRes.ok     ? await agentsRes.json()     : [],
  };
}

// ── 조직도 텍스트 빌드 ────────────────────────────────────────────────
function buildOrgChart(org: Awaited<ReturnType<typeof fetchOrgData>>): string {
  const { divisions, workspaces, teams, parts, agents } = org;
  const lines: string[] = [];

  for (const div of divisions) {
    const divLead = agents.find((a: any) => a.org_level === 'division' && a.workspace_id === div.id);
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

// ── GET /api/missions ─────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const missions = Missions.list(user.id).map(m => ({ ...m, images: m.images ? JSON.parse(m.images) : [] }));
  return Response.json({ ok: true, missions });
}

// ── POST /api/missions ────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { task, images = [] } = await req.json() as { task: string; images?: string[] };
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

  Missions.create({ id, user_id: user.id, task, routing: '[]' });
  Missions.update(id, { status: 'analyzing', images: JSON.stringify(savedImages) });

  // Claude CLI 실행 디렉토리 결정
  const cwd = orgData.workspaces[0]?.path || process.cwd();
  const hasImages = savedImages.length > 0;
  const promptArgs = ['-p', buildRoutingPrompt(orgChart, task, hasImages)];
  if (hasImages) savedImages.forEach(img => promptArgs.push(img.path));

  setImmediate(() => {
    execFile('claude', promptArgs, { cwd, encoding: 'utf8', timeout: 90000, env: { ...process.env } },
      (err, stdout) => {
        if (err) { Missions.update(id, { status: 'routing_failed' }); return; }
        try {
          const cleaned = stdout.trim().replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
          const parsed = JSON.parse(cleaned);

          for (const orgName of (parsed.new_org_needed || [])) {
            Notifications.create({ id: randomUUID(), user_id: user.id, type: 'org_needed',
              title: `${orgName} 생성 권장`, message: `미션에서 ${orgName}이(가) 필요합니다.`, read: 0 });
          }

          Missions.update(id, {
            routing: JSON.stringify(parsed.routing || []),
            status: parsed.needs_clarification ? 'needs_clarification' : 'routed',
            steps: JSON.stringify({ summary: parsed.summary, needs_clarification: parsed.needs_clarification || false,
              clarification: parsed.clarification || null, new_org_needed: parsed.new_org_needed || [] }),
          });
        } catch { Missions.update(id, { status: 'routing_failed' }); }
      }
    );
  });

  return Response.json({ ok: true, mission: { id, task, status: 'analyzing', images: savedImages } });
}

// ── PATCH /api/missions ───────────────────────────────────────────────
export async function PATCH(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { id, extra_routing } = await req.json();
  const m = Missions.get(id);
  if (!m || m.user_id !== user.id) return Response.json({ ok: false, error: '없음' }, { status: 404 });

  const merged = [...JSON.parse(m.routing || '[]'), ...(extra_routing || [])];
  Missions.update(id, { routing: JSON.stringify(merged), status: 'routed' });
  return Response.json({ ok: true, routing: merged });
}

// ── DELETE /api/missions?id=xxx ───────────────────────────────────────
export async function DELETE(req: NextRequest) {
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
  "routing": [{"org_id":"...","org_type":"team","org_name":"...","agent_id":"...","agent_name":"...","subtask":"...","approach":"...","deliverables":[]}],
  "needs_clarification": false,
  "clarification": null,
  "new_org_needed": []
}`;
}
