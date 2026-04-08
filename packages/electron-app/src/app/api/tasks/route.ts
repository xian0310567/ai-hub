import { NextRequest } from 'next/server';
import { Tasks } from '@/lib/db';
import { getSession } from '@/lib/auth';
import { randomUUID } from 'crypto';

// GET /api/tasks
export async function GET(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  return Response.json({ ok: true, tasks: Tasks.list(user.id) });
}

// POST /api/tasks
export async function POST(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { title, description = '', agent_id, agent_name } = await req.json();
  if (!title?.trim()) return Response.json({ ok: false, error: '제목 필수' }, { status: 400 });

  const id = randomUUID();
  Tasks.create({ id, user_id: user.id, agent_id: agent_id ?? null, agent_name: agent_name ?? null, title, description, status: 'pending', result: '' });
  return Response.json({ ok: true, task: Tasks.get(id) });
}

// PATCH /api/tasks
export async function PATCH(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { id, status, result, title, description } = await req.json();
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });

  const task = Tasks.get(id);
  if (!task || task.user_id !== user.id) return Response.json({ ok: false, error: '없음' }, { status: 404 });

  const fields: any = {};
  if (status !== undefined) fields.status = status;
  if (result !== undefined) fields.result = result;
  if (title !== undefined) fields.title = title;
  if (description !== undefined) fields.description = description;
  if (Object.keys(fields).length) Tasks.update(id, fields);

  return Response.json({ ok: true, task: Tasks.get(id) });
}

// DELETE /api/tasks?id=xxx
export async function DELETE(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });

  const task = Tasks.get(id);
  if (!task || task.user_id !== user.id) return Response.json({ ok: false, error: '없음' }, { status: 404 });

  Tasks.delete(id);
  return Response.json({ ok: true });
}
