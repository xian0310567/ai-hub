import { NextRequest } from 'next/server';
import { proxyToVm, proxyBodyToVm, getVmCookie } from '@/lib/vm-proxy';
import { NextResponse } from 'next/server';

const VM_URL = process.env.VM_SERVER_URL || 'http://localhost:4000';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyToVm(req, `/api/vaults/${id}/secrets`);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyBodyToVm(req, `/api/vaults/${id}`, 'PATCH');
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = getVmCookie(req);
  const vmRes = await fetch(`${VM_URL}/api/vaults/${id}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });
  const body = await vmRes.json().catch(() => ({}));
  return NextResponse.json(body, { status: vmRes.status });
}
