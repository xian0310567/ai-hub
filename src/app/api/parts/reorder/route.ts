import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import db from '@/lib/db';

export async function POST(req: NextRequest) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { ids } = await req.json() as { ids: string[] };
  if (!Array.isArray(ids)) return Response.json({ ok: false, error: 'ids required' }, { status: 400 });

  const stmt = db.prepare('UPDATE parts SET order_index=? WHERE id=? AND user_id=?');
  const update = db.transaction(() => {
    ids.forEach((id, i) => stmt.run(i, id, user.id));
  });
  update();
  return Response.json({ ok: true });
}
