import { NextRequest, NextResponse } from 'next/server';
import { getVmCookie } from '@/lib/vm-proxy';

const VM_URL = process.env.VM_SERVER_URL || 'http://localhost:4000';

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; userId: string }> }) {
  const { id, userId } = await params;
  const cookie = getVmCookie(req);
  const vmRes = await fetch(`${VM_URL}/api/teams/${id}/members/${userId}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });
  const body = await vmRes.json().catch(() => ({}));
  return NextResponse.json(body, { status: vmRes.status });
}
