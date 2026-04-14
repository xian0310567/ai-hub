/**
 * OpenClaw Gateway HTTP 클라이언트 (standalone)
 *
 * Gateway의 OpenAI 호환 API를 사용하여 에이전트에게 메시지를 보내고
 * SSE 스트리밍 응답을 받는다.
 * electron-app, vm-server 의존 없이 독립적으로 동작한다.
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
  history?: OpenClawMessage[];
  stream?: boolean;
  timeoutMs?: number;
}

export interface OpenClawStreamChunk {
  text: string;
  done: boolean;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ── 헬스체크 ──────────────────────────────────────────────────────────

export async function isGatewayAvailable(): Promise<boolean> {
  try {
    await fetch(`${GATEWAY_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return true;
  } catch {
    return false;
  }
}

/** Gateway가 완전히 초기화되어 요청을 처리할 준비가 되었는지 확인 */
export async function isGatewayReady(): Promise<boolean> {
  try {
    const res = await fetch(`${GATEWAY_URL}/ready`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── 스트리밍 메시지 전송 ──────────────────────────────────────────────

/**
 * OpenClaw Gateway에 메시지를 보내고 SSE 스트리밍 ReadableStream을 반환한다.
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
          // 타임아웃에 의한 중단
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

// ── 비스트리밍 단발 요청 ─────────────────────────────────────────────

/**
 * Gateway에 메시지를 보내고 전체 응답 텍스트를 반환한다.
 * 스트리밍이 필요 없을 때 간편하게 사용.
 */
export async function sendToGatewaySync(options: Omit<OpenClawSendOptions, 'stream'>): Promise<string> {
  const {
    agentId,
    message,
    sessionKey,
    model,
    history = [],
    timeoutMs = 90000,
  } = options;

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

  const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: `openclaw/${agentId}`,
      messages,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => res.statusText);
    throw new Error(`Gateway ${res.status}: ${errBody}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? '';
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
