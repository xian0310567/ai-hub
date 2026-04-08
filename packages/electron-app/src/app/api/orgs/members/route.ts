import { NextRequest } from 'next/server';
import { proxyToVm, proxyBodyToVm, getVmCookie } from '@/lib/vm-proxy';
import { NextResponse } from 'next/server';

const VM_URL = process.env.VM_SERVER_URL || 'http://localhost:4000';

// GET /api/orgs/members?orgId=xxx  → vm-server GET /api/orgs/:orgId/members
export async function GET(req: NextRequest) {
  const orgId = new URL(req.url).searchParams.get('orgId');
  if (!orgId) return NextResponse.json({ error: 'orgId required' }, { status: 400 });
  return proxyToVm(req, `/api/orgs/${orgId}/members`);
}

// PATCH /api/orgs/members  body: { orgId, userId, role }
export async function PATCH(req: NextRequest) {
  const cookie = getVmCookie(req);
  const { orgId, userId, role } = await req.json();
  const vmRes = await fetch(`${VM_URL}/api/orgs/${orgId}/members/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ role }),
  });
  const body = await vmRes.json().catch(() => ({}));
  return NextResponse.json(body, { status: vmRes.status });
}

// DELETE /api/orgs/members?orgId=xxx&userId=yyy
export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const orgId = url.searchParams.get('orgId');
  const userId = url.searchParams.get('userId');
  if (!orgId || !userId) return NextResponse.json({ error: 'orgId and userId required' }, { status: 400 });
  const cookie = getVmCookie(req);
  const vmRes = await fetch(`${VM_URL}/api/orgs/${orgId}/members/${userId}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });
  const body = await vmRes.json().catch(() => ({}));
  return NextResponse.json(body, { status: vmRes.status });
}
