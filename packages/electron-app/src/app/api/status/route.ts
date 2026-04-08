import { NextResponse } from 'next/server';

export async function GET() {
  const getAllStatuses = (global as any).__getAllStatuses;
  if (!getAllStatuses) return NextResponse.json({ ok: false, agents: {} });
  const agents = getAllStatuses();
  return NextResponse.json({ ok: true, agents });
}
