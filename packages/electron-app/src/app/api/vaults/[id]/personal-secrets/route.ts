/**
 * Personal Vault 시크릿 API
 *
 * POST  /api/vaults/[id]/personal-secrets   — 값은 로컬 키체인에, 메타(key_name)는 vm-server에 등록
 * GET   /api/vaults/[id]/personal-secrets?key_name=XXX — 로컬 키체인에서 값 조회
 */

import { NextRequest } from 'next/server';
import { getSession, getVmSessionCookie } from '@/lib/auth';
import { savePersonalSecret, readPersonalSecret, deletePersonalSecret } from '@/lib/personal-vault';

const VM_URL = process.env.VM_SERVER_URL ?? 'http://localhost:4000';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSession(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: vaultId } = await params;
  const { key_name, value } = await req.json() as { key_name?: string; value?: string };
  if (!key_name?.trim() || !value?.trim()) {
    return Response.json({ error: 'key_name and value required' }, { status: 400 });
  }

  // 1. 로컬 키체인에 값 저장
  await savePersonalSecret(user.id, vaultId, key_name, value);

  // 2. vm-server에 key_name 메타데이터 등록 (값은 placeholder)
  const cookie = getVmSessionCookie(req);
  const vmRes = await fetch(`${VM_URL}/api/vaults/${vaultId}/secrets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ key_name, value: '__personal__' }),
  });

  if (!vmRes.ok && vmRes.status !== 409) {
    // 메타데이터 등록 실패 → 키체인 롤백
    await deletePersonalSecret(user.id, vaultId, key_name);
    const err = await vmRes.json().catch(() => ({})) as { error?: string };
    return Response.json({ error: err.error ?? 'Failed to register key metadata' }, { status: vmRes.status });
  }

  return Response.json({ ok: true, key_name });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSession(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: vaultId } = await params;
  const { searchParams } = new URL(req.url);
  const key_name = searchParams.get('key_name');
  if (!key_name) return Response.json({ error: 'key_name query param required' }, { status: 400 });

  const value = await readPersonalSecret(user.id, vaultId, key_name);
  return Response.json({ key_name, value });
}
