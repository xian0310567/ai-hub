/**
 * 세션 히스토리 API
 *
 * GET /api/sessions
 *   - 사용자의 대화 세션 목록 반환
 *   - ?agent_id=xxx     에이전트별 필터
 *   - ?session_key=xxx  특정 세션 메시지 조회
 *   - ?q=검색어          전문 검색
 *   - ?from=epoch&to=epoch  날짜 범위 필터
 *   - ?export=1&agent_id=xxx&session_key=xxx  세션 내보내기
 *
 * DELETE /api/sessions
 *   - { agent_id, session_key? }  세션 삭제
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { ChatLogs } from '@/lib/db';
import { getSessionHistory } from '@/lib/openclaw-client';

export async function GET(req: NextRequest) {
  const user = await getSession(req);
  if (!user) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const agentId = url.searchParams.get('agent_id');
  const sessionKey = url.searchParams.get('session_key');
  const source = url.searchParams.get('source'); // 'local' | 'gateway' | undefined
  const query = url.searchParams.get('q');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const isExport = url.searchParams.get('export') === '1';

  // 세션 내보내기
  if (isExport && agentId) {
    const data = ChatLogs.exportSession(user.id, agentId, sessionKey ?? undefined);
    return Response.json({ ok: true, ...data });
  }

  // 전문 검색
  if (query) {
    const results = ChatLogs.search(user.id, query);
    return Response.json({ ok: true, query, results });
  }

  // 특정 세션의 메시지 조회
  if (agentId && sessionKey) {
    const localMessages = ChatLogs.sessionMessages(user.id, agentId, sessionKey);

    // Gateway 세션 히스토리도 조회 시도
    let gatewayMessages: Array<{ role: string; content: string }> = [];
    if (source !== 'local') {
      try {
        gatewayMessages = await getSessionHistory(sessionKey);
      } catch {}
    }

    return Response.json({
      ok: true,
      session_key: sessionKey,
      agent_id: agentId,
      local: localMessages,
      gateway: gatewayMessages,
      // 로컬 우선, Gateway 보조
      messages: localMessages.length > 0 ? localMessages : gatewayMessages.map((m, i) => ({
        id: `gw-${i}`,
        user_id: user.id,
        agent_id: agentId,
        role: m.role,
        content: m.content,
        session_key: sessionKey,
        created_at: Math.floor(Date.now() / 1000) - (gatewayMessages.length - i),
      })),
    });
  }

  // 필터링된 세션 목록
  if (agentId || from || to) {
    const sessions = ChatLogs.sessionsFiltered(user.id, {
      agentId: agentId ?? undefined,
      from: from ? parseInt(from, 10) : undefined,
      to: to ? parseInt(to, 10) : undefined,
    });
    return Response.json({ ok: true, sessions });
  }

  // 세션 목록 반환
  const sessions = ChatLogs.sessions(user.id);

  return Response.json({
    ok: true,
    sessions,
  });
}

export async function DELETE(req: NextRequest) {
  const user = await getSession(req);
  if (!user) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { agent_id, session_key } = await req.json();
  if (!agent_id) {
    return Response.json({ ok: false, error: 'agent_id required' }, { status: 400 });
  }

  ChatLogs.deleteSession(user.id, agent_id, session_key ?? undefined);
  return Response.json({ ok: true });
}
