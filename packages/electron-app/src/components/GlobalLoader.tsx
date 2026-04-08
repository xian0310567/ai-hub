'use client';
import { useSyncExternalStore } from 'react';

// ── 외부 스토어: fetch pending 카운터 ───────────────────────────────
let _count = 0;
const _listeners = new Set<() => void>();
function subscribe(fn: () => void) { _listeners.add(fn); return () => { _listeners.delete(fn); }; }
function getSnapshot() { return _count; }
function getServerSnapshot() { return 0; }
function inc() { _count++; _listeners.forEach(fn => fn()); }
function dec() { _count = Math.max(0, _count - 1); _listeners.forEach(fn => fn()); }

// 로딩 오버레이를 건너뛸 URL 패턴
const SKIP_PATTERNS = [
  '/api/missions',       // 미션 (비동기 큐 방식)
  '/api/notifications',  // 알림 (백그라운드 폴링)
];

function shouldSkip(input: RequestInfo | URL): boolean {
  const url = typeof input === 'string' ? input
    : input instanceof URL ? input.pathname
    : input instanceof Request ? new URL(input.url).pathname
    : String(input);
  return SKIP_PATTERNS.some(p => url.includes(p));
}

// ── 모듈 로드 시점에 fetch 패치 (useEffect보다 먼저 실행) ────────────
if (typeof window !== 'undefined' && !(window as any).__globalLoaderPatched) {
  (window as any).__globalLoaderPatched = true;
  const origFetch = window.fetch.bind(window);
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (shouldSkip(input)) return origFetch(input, init);
    inc();
    return origFetch(input, init).then(
      (res: Response) => { dec(); return res; },
      (err: any) => { dec(); throw err; },
    );
  };
}

export default function GlobalLoader() {
  const pending = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (pending === 0) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 99999,
      backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
      background: 'rgba(8,8,12,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <div style={{
          width: 42, height: 42, borderRadius: '50%',
          border: '3px solid rgba(255,255,255,0.08)',
          borderTopColor: '#0d99ff',
          animation: 'spin 0.65s linear infinite',
        }} />
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', fontWeight: 500, letterSpacing: '0.1em' }}>
          처리 중...
        </span>
      </div>
    </div>
  );
}
