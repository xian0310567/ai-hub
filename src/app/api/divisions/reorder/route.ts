import db from '@/lib/db';

// POST /api/divisions/reorder — { ids: string[] } 순서대로 order_index 업데이트
export async function POST(req: Request) {
  const { ids } = await req.json() as { ids: string[] };
  if (!Array.isArray(ids)) return Response.json({ ok:false, error:'ids required' }, { status:400 });
  const stmt = db.prepare('UPDATE divisions SET order_index=? WHERE id=?');
  ids.forEach((id, i) => stmt.run(i, id));
  return Response.json({ ok: true });
}
