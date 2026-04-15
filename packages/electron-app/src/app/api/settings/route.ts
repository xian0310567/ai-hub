/**
 * Settings API
 *
 * GET  /api/settings?key=xxx        — 설정 값 조회
 * GET  /api/settings                — 전체 설정 조회
 * POST /api/settings { key, value } — 설정 값 저장
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { Settings } from '@/lib/db';

const ALLOWED_KEYS = ['gateway_auto_start'] as const;

function isAllowedKey(key: string): key is (typeof ALLOWED_KEYS)[number] {
  return (ALLOWED_KEYS as readonly string[]).includes(key);
}

export async function GET(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const key = new URL(req.url).searchParams.get('key');

  if (key) {
    if (!isAllowedKey(key)) {
      return Response.json({ ok: false, error: `허용되지 않는 설정: ${key}` }, { status: 400 });
    }
    return Response.json({ ok: true, key, value: Settings.get(key) ?? null });
  }

  // 전체 허용 키 조회
  const entries: Record<string, string | null> = {};
  for (const k of ALLOWED_KEYS) {
    entries[k] = Settings.get(k) ?? null;
  }
  return Response.json({ ok: true, settings: entries });
}

export async function POST(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { key, value } = await req.json();
  if (!key || typeof value !== 'string') {
    return Response.json({ ok: false, error: 'key와 value(string)가 필요합니다.' }, { status: 400 });
  }
  if (!isAllowedKey(key)) {
    return Response.json({ ok: false, error: `허용되지 않는 설정: ${key}` }, { status: 400 });
  }

  Settings.set(key, value);
  return Response.json({ ok: true, key, value });
}
