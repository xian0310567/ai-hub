import { NextRequest } from 'next/server';
import { proxyToVm, proxyBodyToVm } from '@/lib/vm-proxy';

export async function GET(req: NextRequest) {
  return proxyToVm(req, '/api/vaults');
}

export async function POST(req: NextRequest) {
  return proxyBodyToVm(req, '/api/vaults', 'POST');
}
