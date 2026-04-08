import { NextRequest } from 'next/server';
import { proxyToVm } from '@/lib/vm-proxy';

export async function GET(req: NextRequest) {
  const qs = new URL(req.url).search;
  return proxyToVm(req, `/api/audit${qs}`);
}
