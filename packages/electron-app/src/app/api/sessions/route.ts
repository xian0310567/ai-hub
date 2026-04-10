/**
 * 세션 히스토리 API
 *
 * GET /api/sessions
 *   - 사용자의 대화 세션 목록 반환
 *   - ?agent_id=xxx 로 특정 에이전트 필터링
 *   - ?session_key=xxx 로 특정 세션 메시지 조회
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
      })),
    });
  }

  // 세션 목록 반환
  const sessions = ChatLogs.sessions(user.id);

  return Response.json({
    ok: true,
    sessions,
  });
}
