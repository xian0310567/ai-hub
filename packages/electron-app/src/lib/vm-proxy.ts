/**
 * electron-app Next.js API → vm-server 프록시 유틸
 * 세션 쿠키를 electron-app(localhost:3000) 쿠키로 중계
 */
import { NextRequest, NextResponse } from 'next/server';

const VM_URL = process.env.VM_SERVER_URL || 'http://localhost:4000';

/** 요청에서 vm 세션 쿠키값 추출 */
export function getVmCookie(req: NextRequest): string {
  const session = req.cookies.get('vm_session')?.value;
  return session ? `session=${session}` : '';
}

/** vm-server 응답의 Set-Cookie에서 session ID를 꺼내 vm_session으로 중계 */
function relaySessionCookie(vmRes: Response, res: NextResponse): void {
  const setCookie = vmRes.headers.get('set-cookie');
  if (!setCookie) return;

  // session=<value>; ... 파싱
  const match = setCookie.match(/session=([^;]+)/);
  if (!match) return;

  const maxAgeMatch = setCookie.match(/Max-Age=(\d+)/i) || setCookie.match(/max-age=(\d+)/i);
  const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : 60 * 60 * 24 * 30;

  res.cookies.set('vm_session', match[1], {
    httpOnly: true,
    sameSite: 'lax',
    maxAge,
    path: '/',
  });
}

/** vm-server로 단순 프록시 (GET/DELETE) */
export async function proxyToVm(
  req: NextRequest,
  path: string,
  options: RequestInit = {}
): Promise<NextResponse> {
  const cookie = getVmCookie(req);

  const vmRes = await fetch(`${VM_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });

  const body = await vmRes.json().catch(() => ({}));
  const res = NextResponse.json(body, { status: vmRes.status });
  relaySessionCookie(vmRes, res);
  return res;
}

/** POST/PATCH body를 포함한 프록시 */
export async function proxyBodyToVm(
  req: NextRequest,
  path: string,
  method: string
): Promise<NextResponse> {
  const cookie = getVmCookie(req);
  const body = await req.json().catch(() => ({}));

  const vmRes = await fetch(`${VM_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });

  const resBody = await vmRes.json().catch(() => ({}));
  const res = NextResponse.json(resBody, { status: vmRes.status });
  relaySessionCookie(vmRes, res);
  return res;
}
