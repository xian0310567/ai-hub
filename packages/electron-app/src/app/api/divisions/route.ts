import { NextRequest } from 'next/server';
import { proxyToVm, proxyBodyToVm } from '@/lib/vm-proxy';

export async function GET(req: NextRequest) {
  return proxyToVm(req, '/api/divisions/tree');
}

export async function POST(req: NextRequest) {
  return proxyBodyToVm(req, '/api/divisions', 'POST');
}

export async function PATCH(req: NextRequest) {
  return proxyBodyToVm(req, '/api/divisions', 'PATCH');
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id');
  // 원래 req를 직접 사용하되 body를 오버라이드하기 위해 proxyBodyToVm 대신 직접 처리
  const { getVmCookie } = await import('@/lib/vm-proxy');
  const cookie = getVmCookie(req);
  const VM_URL = process.env.VM_SERVER_URL || 'http://localhost:4000';
  const vmRes = await fetch(`${VM_URL}/api/divisions`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ id }),
  });
  const body = await vmRes.json().catch(() => ({}));
  const { NextResponse } = await import('next/server');
  return NextResponse.json(body, { status: vmRes.status });
}
