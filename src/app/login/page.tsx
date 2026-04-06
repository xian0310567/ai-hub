'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode]         = useState<'signin' | 'signup'>('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  useEffect(() => {
    fetch('/api/auth/me').then(r => {
      if (r.ok) router.replace('/');
    }).catch(() => {});
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const endpoint = mode === 'signin' ? '/api/auth/signin' : '/api/auth/signup';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (data.ok) {
        router.replace('/');
      } else {
        setError(data.error || '오류가 발생했습니다');
      }
    } catch {
      setError('서버 연결 오류');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: '#1e1e1e',
      backgroundImage: 'linear-gradient(#313131 1px, transparent 1px), linear-gradient(90deg, #313131 1px, transparent 1px)',
      backgroundSize: '24px 24px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }}>
      <div style={{
        width: 360,
        background: '#252526',
        border: '1px solid #3e3e3e',
        borderRadius: 8,
        padding: '32px 28px',
        boxShadow: '0 16px 48px rgba(0,0,0,.5)',
      }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 10,
            background: '#0d99ff22', border: '1px solid #0d99ff44',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22, margin: '0 auto 12px',
          }}>🏢</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#e8e8e8' }}>AI 사업부 허브</div>
          <div style={{ fontSize: 12, color: '#616161', marginTop: 4 }}>
            {mode === 'signin' ? '로그인하여 계속하기' : '새 계정 만들기'}
          </div>
        </div>

        <form onSubmit={submit}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, fontWeight: 500, color: '#9d9d9d', display: 'block', marginBottom: 5 }}>아이디</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="username"
              autoComplete="username"
              required
              style={{
                width: '100%', boxSizing: 'border-box',
                background: '#1e1e1e', border: '1px solid #3e3e3e',
                color: '#e8e8e8', padding: '8px 11px', fontSize: 13,
                outline: 'none', borderRadius: 4, fontFamily: 'inherit',
                transition: 'border-color .12s',
              }}
              onFocus={e => e.target.style.borderColor = '#0d99ff'}
              onBlur={e => e.target.style.borderColor = '#3e3e3e'}
            />
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={{ fontSize: 11, fontWeight: 500, color: '#9d9d9d', display: 'block', marginBottom: 5 }}>비밀번호</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              required
              style={{
                width: '100%', boxSizing: 'border-box',
                background: '#1e1e1e', border: '1px solid #3e3e3e',
                color: '#e8e8e8', padding: '8px 11px', fontSize: 13,
                outline: 'none', borderRadius: 4, fontFamily: 'inherit',
                transition: 'border-color .12s',
              }}
              onFocus={e => e.target.style.borderColor = '#0d99ff'}
              onBlur={e => e.target.style.borderColor = '#3e3e3e'}
            />
          </div>

          {error && (
            <div style={{
              marginBottom: 14, padding: '8px 11px',
              background: '#f2482211', border: '1px solid #f2482233',
              color: '#f24822', fontSize: 12, borderRadius: 4,
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%', padding: '9px', fontSize: 13, fontWeight: 600,
              background: loading ? '#0a7acc' : '#0d99ff',
              color: '#fff', border: 'none',
              cursor: loading ? 'default' : 'pointer',
              borderRadius: 4, fontFamily: 'inherit',
              transition: 'background .12s',
            }}
          >
            {loading ? '처리중...' : mode === 'signin' ? '로그인' : '회원가입'}
          </button>
        </form>

        <div style={{ textAlign: 'center', marginTop: 18 }}>
          <button
            onClick={() => { setMode(m => m === 'signin' ? 'signup' : 'signin'); setError(''); }}
            style={{
              background: 'none', border: 'none', color: '#616161',
              fontSize: 12, cursor: 'pointer',
              fontFamily: 'inherit', transition: 'color .12s',
            }}
            onMouseOver={e => e.currentTarget.style.color = '#9d9d9d'}
            onMouseOut={e => e.currentTarget.style.color = '#616161'}
          >
            {mode === 'signin' ? '계정이 없으신가요? 회원가입' : '이미 계정이 있으신가요? 로그인'}
          </button>
        </div>
      </div>
    </div>
  );
}
