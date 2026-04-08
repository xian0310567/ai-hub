import { NextRequest } from 'next/server';
import { proxyBodyToVm } from '@/lib/vm-proxy';

export async function POST(req: NextRequest) {
  return proxyBodyToVm(req, '/api/divisions/reorder', 'POST');
}
