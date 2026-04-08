/**
 * Personal Vault 시크릿 삭제
 * DELETE /api/vaults/[id]/personal-secrets/[secretId]
 *
 * secretId는 vm-server vault_secrets.id
 * key_name은 query param으로 전달 (로컬 키체인 삭제용)
 */

import { NextRequest } from 'next/server';
import { getSession, getVmSessionCookie } from '@/lib/auth';
import { deletePersonalSecret } from '@/lib/personal-vault';

const VM_URL = process.env.VM_SERVER_URL ?? 'http://localhost:4000';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; secretId: string }> },
) {
  const user = await getSession(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: vaultId, secretId } = await params;
  const { searchParams } = new URL(req.url);
  const key_name = searchParams.get('key_name');

  // 로컬 키체인에서 삭제 (key_name이 있을 때만)
  if (key_name) {
    await deletePersonalSecret(user.id, vaultId, key_name);
  }

  // vm-server에서 메타데이터 삭제
  const cookie = getVmSessionCookie(req);
  const vmRes = await fetch(`${VM_URL}/api/vaults/${vaultId}/secrets/${secretId}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });

  if (!vmRes.ok) {
    const err = await vmRes.json().catch(() => ({})) as { error?: string };
    return Response.json({ error: err.error ?? 'Failed to delete key metadata' }, { status: vmRes.status });
  }

  return Response.json({ ok: true });
}
