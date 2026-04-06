import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  return Response.json({ ok: true, user: { id: user.id, username: user.username } });
}
