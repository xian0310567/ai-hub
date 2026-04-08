import { NextRequest } from 'next/server';
import { proxyToVm, proxyBodyToVm } from '@/lib/vm-proxy';

export async function GET(req: NextRequest) {
  const qs = new URL(req.url).search;
  return proxyToVm(req, `/api/tasks${qs}`);
}

export async function POST(req: NextRequest) {
  return proxyBodyToVm(req, '/api/tasks', 'POST');
}

export async function PATCH(req: NextRequest) {
  return proxyBodyToVm(req, '/api/tasks', 'PATCH');
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id');
  return proxyBodyToVm(
    new Request(req, { body: JSON.stringify({ id }) }) as NextRequest,
    '/api/tasks',
    'DELETE'
  );
}
