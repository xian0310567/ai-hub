import { NextRequest } from 'next/server';
import { proxyToVm, proxyBodyToVm } from '@/lib/vm-proxy';

export async function GET(req: NextRequest) {
  return proxyToVm(req, '/api/workspaces');
}

export async function POST(req: NextRequest) {
  return proxyBodyToVm(req, '/api/workspaces', 'POST');
}

export async function PATCH(req: NextRequest) {
  return proxyBodyToVm(req, '/api/workspaces', 'PATCH');
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id');
  return proxyBodyToVm(req, '/api/workspaces', 'DELETE', { id });
}
