import { NextRequest, NextResponse } from 'next/server';
import { Sessions } from '@/lib/db';

export async function POST(req: NextRequest) {
  const sessionId = req.cookies.get('session')?.value;
  if (sessionId) Sessions.delete(sessionId);

  const res = NextResponse.json({ ok: true });
  res.cookies.set('session', '', { maxAge: 0, path: '/' });
  return res;
}
