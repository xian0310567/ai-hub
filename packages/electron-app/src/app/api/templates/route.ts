/**
 * GET  /api/templates   — 사용자 템플릿 + 빌트인 목록
 * POST /api/templates   — 새 템플릿 생성
 */
import { NextRequest } from 'next/server';
import { MissionTemplates } from '@/lib/db';
import { getSession } from '@/lib/auth';
import { randomUUID } from 'crypto';

export async function GET(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  const templates = MissionTemplates.list(user.id);
  return Response.json({ ok: true, templates });
}

export async function POST(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body?.name || !body?.task) {
    return Response.json({ ok: false, error: 'name, task 필수' }, { status: 400 });
  }

  const id = randomUUID();
  MissionTemplates.create({
    id,
    user_id: user.id,
    name: String(body.name).slice(0, 100),
    description: String(body.description ?? '').slice(0, 500),
    task: String(body.task),
    tags: Array.isArray(body.tags) ? JSON.stringify(body.tags) : '[]',
    is_builtin: 0,
  });

  return Response.json({ ok: true, id });
}
