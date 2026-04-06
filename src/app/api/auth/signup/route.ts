import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { Users } from '@/lib/db';
import { hashPassword, createSessionToken } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const { username, password } = await req.json() as { username?: string; password?: string };

  if (!username?.trim() || !password) {
    return Response.json({ ok: false, error: '아이디와 비밀번호를 입력하세요' }, { status: 400 });
  }
  if (username.length < 3 || username.length > 30) {
    return Response.json({ ok: false, error: '아이디는 3~30자여야 합니다' }, { status: 400 });
  }
  if (password.length < 6) {
    return Response.json({ ok: false, error: '비밀번호는 6자 이상이어야 합니다' }, { status: 400 });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return Response.json({ ok: false, error: '아이디는 영문, 숫자, _, - 만 사용 가능합니다' }, { status: 400 });
  }

  if (Users.getByUsername(username)) {
    return Response.json({ ok: false, error: '이미 사용 중인 아이디입니다' }, { status: 409 });
  }

  const id = randomUUID();
  Users.create({ id, username, password_hash: hashPassword(password) });

  const token = createSessionToken(id);
  const res = NextResponse.json({ ok: true, user: { id, username } });
  res.cookies.set('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60,
    path: '/',
  });
  return res;
}
