import { NextRequest } from 'next/server';
import { proxyToVm, proxyBodyToVm } from '@/lib/vm-proxy';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyToVm(req, `/api/teams/${id}/members`);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyBodyToVm(req, `/api/teams/${id}/members`, 'POST');
}
