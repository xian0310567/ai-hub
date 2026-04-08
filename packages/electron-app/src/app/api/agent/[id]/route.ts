import { NextResponse } from 'next/server';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const getAgentStatus = (global as any).__getAgentStatus;
  if (!getAgentStatus) return NextResponse.json({ ok: false });
  const data = getAgentStatus(id);
  return NextResponse.json({ ok: true, agentId: id, ...data });
}
