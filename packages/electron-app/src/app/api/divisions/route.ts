import { NextRequest } from 'next/server';
import { proxyToVm, proxyBodyToVm } from '@/lib/vm-proxy';

export async function GET(req: NextRequest) {
  return proxyToVm(req, '/api/divisions');
}

export async function POST(req: NextRequest) {
  return proxyBodyToVm(req, '/api/divisions', 'POST');
}

export async function PATCH(req: NextRequest) {
  return proxyBodyToVm(req, '/api/divisions', 'PATCH');
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id');
  return proxyBodyToVm(
    new Request(req, { body: JSON.stringify({ id }) }) as NextRequest,
    '/api/divisions',
    'DELETE'
  );
}
