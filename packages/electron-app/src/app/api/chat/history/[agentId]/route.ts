import { NextRequest } from 'next/server';
import { ChatLogs } from '@/lib/db';
import { getSession } from '@/lib/auth';

export async function GET(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { agentId } = await params;
  const logs = ChatLogs.list(user.id, agentId, 200);
  return Response.json({ ok: true, logs });
}
