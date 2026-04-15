/**
 * DELETE /api/templates/[id] — 템플릿 삭제 (본인 소유 또는 빌트인 아닌 것만)
 */
import { NextRequest } from 'next/server';
import { MissionTemplates } from '@/lib/db';
import { getSession } from '@/lib/auth';

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const template = MissionTemplates.get(id);
  if (!template) return Response.json({ ok: false, error: '없음' }, { status: 404 });
  if (template.user_id !== user.id || template.is_builtin)
    return Response.json({ ok: false, error: '삭제 권한 없음' }, { status: 403 });

  MissionTemplates.delete(id);
  return Response.json({ ok: true });
}
