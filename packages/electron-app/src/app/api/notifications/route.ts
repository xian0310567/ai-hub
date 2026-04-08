import { NextRequest } from 'next/server';
import { Notifications } from '@/lib/db';
import { getSession } from '@/lib/auth';
import { randomUUID } from 'crypto';

export async function GET(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  const notifications = Notifications.list(user.id);
  const unread = Notifications.unreadCount(user.id);
  return Response.json({ ok: true, notifications, unread });
}

export async function POST(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  const { type, title, message } = await req.json();
  const id = randomUUID();
  Notifications.create({ id, user_id: user.id, type: type||'info', title, message, read: 0 });
  return Response.json({ ok: true, id });
}

export async function PATCH(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  const { id, all } = await req.json();
  if (all) Notifications.markAllRead(user.id);
  else if (id) Notifications.markRead(id);
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });
  Notifications.delete(id);
  return Response.json({ ok: true });
}
