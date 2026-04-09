/**
 * GET  /api/mcp-configs   — 사용자 MCP 서버 목록
 * POST /api/mcp-configs   — 새 MCP 서버 등록
 */
import { NextRequest } from 'next/server';
import { McpServerConfigs } from '@/lib/db';
import { getSession } from '@/lib/auth';
import { randomUUID } from 'crypto';

export async function GET(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  const configs = McpServerConfigs.list(user.id);
  return Response.json({ ok: true, configs });
}

export async function POST(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body?.name || !body?.command) {
    return Response.json({ ok: false, error: 'name, command 필수' }, { status: 400 });
  }

  // args 배열 또는 문자열 처리
  let args = '[]';
  if (Array.isArray(body.args)) args = JSON.stringify(body.args);
  else if (typeof body.args === 'string') args = body.args;

  // env_json 객체 또는 문자열 처리
  let env_json = '{}';
  if (body.env && typeof body.env === 'object') env_json = JSON.stringify(body.env);
  else if (typeof body.env_json === 'string') env_json = body.env_json;

  const id = randomUUID();
  McpServerConfigs.create({
    id,
    user_id: user.id,
    name: String(body.name).slice(0, 100),
    label: String(body.label ?? body.name).slice(0, 200),
    command: String(body.command),
    args,
    env_json,
  });

  return Response.json({ ok: true, id });
}
