import { NextRequest } from 'next/server';
import { proxyToVm, proxyBodyToVm } from '@/lib/vm-proxy';

export async function GET(req: NextRequest) {
  const qs = new URL(req.url).search;
  return proxyToVm(req, `/api/teams${qs}`);
}

export async function POST(req: NextRequest) {
  return proxyBodyToVm(req, '/api/teams', 'POST');
}

export async function PATCH(req: NextRequest) {
  return proxyBodyToVm(req, '/api/teams', 'PATCH');
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id');
  return proxyBodyToVm(req, '/api/teams', 'DELETE', { id });
}
