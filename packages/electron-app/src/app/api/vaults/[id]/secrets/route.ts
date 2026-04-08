import { NextRequest } from 'next/server';
import { proxyBodyToVm } from '@/lib/vm-proxy';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyBodyToVm(req, `/api/vaults/${id}/secrets`, 'POST');
}
