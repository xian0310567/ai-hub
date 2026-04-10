/**
 * OpenClaw Gateway 경유 에이전트 채팅 API
 *
 * POST /api/openclaw/chat/[agentId]
 * - Gateway의 OpenAI 호환 API를 사용하여 에이전트에게 메시지 전달
 * - SSE 스트리밍 응답 반환
 * - 세션 자동 관리 (Gateway 측)
 *
 * GET /api/openclaw/chat/[agentId]
 * - Gateway 연결 상태 및 세션 정보 조회
 */

import { NextRequest } from 'next/server';
import { getSession, getVmSessionCookie } from '@/lib/auth';
import { ChatLogs } from '@/lib/db';
import { randomUUID } from 'crypto';
import {
  sendToGateway,
  isGatewayAvailable,
  killSession,
} from '@/lib/openclaw-client';

const VM_URL = process.env.VM_SERVER_URL || 'http://localhost:4000';

interface VmAgent {
  id: string;
  name: string;
  command_name?: string;
  model?: string;
  soul?: string;
  harness_pattern?: string;
  org_level?: string;
}

async function fetchAgent(agentId: string, cookie: string): Promise<VmAgent | null> {
  try {
    const res = await fetch(`${VM_URL}/api/agents/${agentId}`, {
      headers: { Cookie: cookie },
    });
    if (!res.ok) return null;
    return res.json() as Promise<VmAgent>;
  } catch {
    return null;
  }
}

// ── POST: 메시지 전송 ────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const user = await getSession(req);
  if (!user) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { agentId } = await params;
  const body = await req.json() as {
    message?: string;
    reset?: boolean;
    sessionKey?: string;
  };

  // 세션 리셋
  if (body.reset) {
    const sessionKey = body.sessionKey || `${user.id}:${agentId}`;
    await killSession(sessionKey).catch(() => {});
    ChatLogs.clear(user.id, agentId);
    return Response.json({ ok: true });
  }

  if (!body.message) {
    return Response.json({ ok: false, error: 'message required' }, { status: 400 });
  }

  // Gateway 가용성 확인
  const available = await isGatewayAvailable();
  if (!available) {
    return Response.json(
      { ok: false, error: 'OpenClaw Gateway에 연결할 수 없습니다. Gateway가 실행 중인지 확인해주세요.' },
      { status: 503 },
    );
  }

  // 에이전트 조회
  const cookie = getVmSessionCookie(req);
  const agent = await fetchAgent(agentId, cookie);
  if (!agent) {
    return Response.json(
      { ok: false, error: '에이전트를 찾을 수 없습니다' },
      { status: 404 },
    );
  }

  // 사용자 메시지 저장
  ChatLogs.add({
    id: randomUUID(),
    user_id: user.id,
    agent_id: agentId,
    role: 'user',
    content: body.message,
  });

  // OpenClaw Gateway에 세션키 기반으로 전송
  const sessionKey = body.sessionKey || `${user.id}:${agentId}`;
  const openclawAgentId = agent.command_name || agentId;

  const stream = sendToGateway({
    agentId: openclawAgentId,
    message: body.message,
    sessionKey,
    model: agent.model ? `claude-cli/${agent.model}` : undefined,
    stream: true,
  });

  // 스트리밍 응답을 프록시하면서 전체 텍스트도 수집
  const [browserStream, logStream] = stream.tee();

  // 백그라운드에서 전체 응답을 수집하여 로그 저장
  (async () => {
    const reader = logStream.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value, { stream: true });
      }
      if (fullText.trim()) {
        ChatLogs.add({
          id: randomUUID(),
          user_id: user.id,
          agent_id: agentId,
          role: 'assistant',
          content: fullText.trim(),
        });
      }
    } catch {}
  })();

  return new Response(browserStream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'X-OpenClaw-Session-Key': sessionKey,
    },
  });
}

// ── GET: 상태 조회 ───────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const user = await getSession(req);
  if (!user) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { agentId } = await params;
  const gatewayAvailable = await isGatewayAvailable();

  return Response.json({
    ok: true,
    gateway: {
      available: gatewayAvailable,
      url: process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789',
    },
    sessionKey: `${user.id}:${agentId}`,
  });
}
