'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ko">
      <body>
        <div style={{ padding: '50px', textAlign: 'center' }}>
          <h1>오류가 발생했습니다</h1>
          <p>페이지를 새로고침 해주세요.</p>
          {error && <p style={{ fontSize: '12px', color: '#666', marginTop: '10px' }}>{error.message}</p>}
          <button onClick={() => reset()} style={{ marginTop: '20px', padding: '10px 20px' }}>
            다시 시도
          </button>
        </div>
      </body>
    </html>
  );
}
