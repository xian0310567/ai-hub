import { NextRequest, NextResponse } from 'next/server';
import { Users } from '@/lib/db';
import { verifyPassword, createSessionToken } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const { username, password } = await req.json() as { username?: string; password?: string };

  if (!username?.trim() || !password) {
    return Response.json({ ok: false, error: '아이디와 비밀번호를 입력하세요' }, { status: 400 });
  }

  const user = Users.getByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return Response.json({ ok: false, error: '아이디 또는 비밀번호가 올바르지 않습니다' }, { status: 401 });
  }

  const token = createSessionToken(user.id);
  const res = NextResponse.json({ ok: true, user: { id: user.id, username: user.username } });
  res.cookies.set('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60,
    path: '/',
  });
  return res;
}
