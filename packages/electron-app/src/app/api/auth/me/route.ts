import { NextRequest } from 'next/server';
import { proxyToVm } from '@/lib/vm-proxy';

export async function GET(req: NextRequest) {
  return proxyToVm(req, '/api/auth/me');
}
