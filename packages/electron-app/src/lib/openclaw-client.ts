/**
 * OpenClaw Gateway HTTP 클라이언트
 *
 * Gateway의 OpenAI 호환 API를 사용하여 에이전트에게 메시지를 보내고
 * SSE 스트리밍 응답을 받는다.
 *
 * Gateway 주소: OPENCLAW_GATEWAY_URL 환경변수 또는 localhost:18789
 */

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

// ── 타입 ──────────────────────────────────────────────────────────────

export interface OpenClawMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface OpenClawSendOptions {
  agentId: string;
  message: string;
  sessionKey?: string;
  model?: string;
  /** 이전 대화 컨텍스트 (없으면 Gateway 세션에서 자동 관리) */
  history?: OpenClawMessage[];
  /** 스트리밍 여부 (기본: true) */
  stream?: boolean;
  /** 타임아웃 (ms, 기본: 90000) */
  timeoutMs?: number;
}

export interface OpenClawStreamChunk {
  /** delta text content */
  text: string;
  /** 마지막 청크 여부 */
  done: boolean;
  /** 사용 토큰 (마지막 청크에만) */
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ── 헬스체크 ──────────────────────────────────────────────────────────

export async function isGatewayAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${GATEWAY_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    // Gateway가 응답하면 가용 상태로 판단 (확장 모듈 오류 등으로 500이 올 수 있음)
    return res.status > 0;
  } catch {
    return false;
  }
}

// ── 스트리밍 메시지 전송 ──────────────────────────────────────────────

/**
 * OpenClaw Gateway에 메시지를 보내고 SSE 스트리밍 ReadableStream을 반환한다.
 * 프론트엔드에서 바로 Response body로 사용 가능.
 */
export function sendToGateway(options: OpenClawSendOptions): ReadableStream<Uint8Array> {
  const {
    agentId,
    message,
    sessionKey,
    model,
    history = [],
    stream = true,
    timeoutMs = 90000,
  } = options;

  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      let closed = false;
      const safeClose = () => { if (!closed) { closed = true; controller.close(); } };
      const safeEnqueue = (chunk: Uint8Array) => { if (!closed) controller.enqueue(chunk); };

      const abortCtrl = new AbortController();
      const timeout = setTimeout(() => {
        abortCtrl.abort();
        safeEnqueue(encoder.encode('\n[타임아웃]'));
        safeClose();
      }, timeoutMs);

      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

      try {
        const messages: OpenClawMessage[] = [
          ...history,
          { role: 'user', content: message },
        ];

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'x-openclaw-agent-id': agentId,
        };
        if (GATEWAY_TOKEN) headers['Authorization'] = `Bearer ${GATEWAY_TOKEN}`;
        if (sessionKey) headers['x-openclaw-session-key'] = sessionKey;
        if (model) headers['x-openclaw-model'] = model;

        const body = JSON.stringify({
          model: `openclaw/${agentId}`,
          messages,
          stream,
        });

        const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body,
          signal: abortCtrl.signal,
        });

        if (!res.ok) {
          const errBody = await res.text().catch(() => res.statusText);
          safeEnqueue(encoder.encode(`[Gateway 오류 ${res.status}] ${errBody}`));
          safeClose();
          clearTimeout(timeout);
          return;
        }

        if (!stream || !res.body) {
          // 비스트리밍 응답
          const data = await res.json() as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const text = data.choices?.[0]?.message?.content ?? '';
          safeEnqueue(encoder.encode(text));
          safeClose();
          clearTimeout(timeout);
          return;
        }

        // SSE 스트리밍 파싱
        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data) as {
                choices?: Array<{
                  delta?: { content?: string };
                  finish_reason?: string | null;
                }>;
                usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
              };
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                safeEnqueue(encoder.encode(content));
              }
            } catch {
              // JSON 파싱 실패 무시
            }
          }
        }

        safeClose();
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          // 타임아웃에 의한 중단 — 이미 처리됨
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          safeEnqueue(encoder.encode(`\n[Gateway 연결 오류] ${msg}`));
          safeClose();
        }
      } finally {
        try { reader?.releaseLock(); } catch {}
        clearTimeout(timeout);
      }
    },
  });
}

// ── 세션 히스토리 ─────────────────────────────────────────────────────

export async function getSessionHistory(sessionKey: string, limit = 50): Promise<OpenClawMessage[]> {
  const headers: Record<string, string> = {};
  if (GATEWAY_TOKEN) headers['Authorization'] = `Bearer ${GATEWAY_TOKEN}`;

  const res = await fetch(
    `${GATEWAY_URL}/sessions/${encodeURIComponent(sessionKey)}/history?limit=${limit}`,
    { headers },
  );
  if (!res.ok) return [];

  const data = await res.json() as {
    messages?: Array<{ role: string; content: string }>;
  };
  return (data.messages ?? []).map(m => ({
    role: m.role as 'user' | 'assistant' | 'system',
    content: m.content,
  }));
}

// ── 세션 중단 ─────────────────────────────────────────────────────────

export async function killSession(sessionKey: string): Promise<boolean> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (GATEWAY_TOKEN) headers['Authorization'] = `Bearer ${GATEWAY_TOKEN}`;

  const res = await fetch(
    `${GATEWAY_URL}/sessions/${encodeURIComponent(sessionKey)}/kill`,
    { method: 'POST', headers },
  );
  return res.ok;
}

// ── Gateway 상태 ──────────────────────────────────────────────────────

export async function getGatewayStatus(): Promise<{
  available: boolean;
  url: string;
  ready?: boolean;
}> {
  const available = await isGatewayAvailable();
  let ready = false;

  if (available) {
    try {
      const res = await fetch(`${GATEWAY_URL}/ready`, {
        signal: AbortSignal.timeout(3000),
      });
      ready = res.ok;
    } catch {}
  }

  return { available, url: GATEWAY_URL, ready };
}
