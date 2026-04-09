/**
 * PATCH  /api/mcp-configs/[id] — enabled 토글
 * DELETE /api/mcp-configs/[id] — 삭제
 */
import { NextRequest } from 'next/server';
import { McpServerConfigs } from '@/lib/db';
import { getSession } from '@/lib/auth';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const cfg = McpServerConfigs.get(id);
  if (!cfg) return Response.json({ ok: false, error: '없음' }, { status: 404 });
  if (cfg.user_id !== user.id) return Response.json({ ok: false, error: '권한 없음' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : !cfg.enabled;
  McpServerConfigs.setEnabled(id, enabled);
  return Response.json({ ok: true, enabled });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const cfg = McpServerConfigs.get(id);
  if (!cfg) return Response.json({ ok: false, error: '없음' }, { status: 404 });
  if (cfg.user_id !== user.id) return Response.json({ ok: false, error: '권한 없음' }, { status: 403 });

  McpServerConfigs.delete(id);
  return Response.json({ ok: true });
}
