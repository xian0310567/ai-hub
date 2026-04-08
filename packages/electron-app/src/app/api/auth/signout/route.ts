import { NextRequest, NextResponse } from 'next/server';
import { proxyBodyToVm } from '@/lib/vm-proxy';

export async function POST(req: NextRequest) {
  const res = await proxyBodyToVm(req, '/api/auth/signout', 'POST');
  // vm_session 쿠키도 함께 제거
  res.cookies.set('vm_session', '', { maxAge: 0, path: '/' });
  return res;
}
