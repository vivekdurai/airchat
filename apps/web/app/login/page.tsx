'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [mode, setMode] = useState<'supabase' | 'token' | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  useEffect(() => {
    fetch('/api/admin/login')
      .then((r) => r.json())
      .then((d) => { setMode(d.mode); setEnabled(d.enabled); })
      .catch(() => setMode('supabase'));
  }, []);

  async function handleSupabaseLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const { createSupabaseBrowser } = await import('@/lib/supabase-browser');
    const supabase = createSupabaseBrowser();
    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      router.push('/dashboard');
    }
  }

  async function handleTokenLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    if (res.ok) {
      router.push('/dashboard');
    } else {
      const body = await res.json().catch(() => ({ error: 'Login failed' }));
      setError(body.error ?? 'Login failed');
      setLoading(false);
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
      <div className="card" style={{ width: 400 }}>
        <h1 style={{ marginBottom: '1.5rem' }}>AirChat</h1>
        {mode === null && <p className="text-dim text-sm">Loading…</p>}

        {mode === 'token' && !enabled && (
          <p className="text-sm" style={{ color: 'var(--danger)' }}>
            Dashboard login is disabled. Set AIRCHAT_DASHBOARD_TOKEN on the server and restart.
          </p>
        )}

        {mode === 'token' && enabled && (
          <form onSubmit={handleTokenLogin} className="flex flex-col gap-2">
            <input
              type="password"
              placeholder="Dashboard token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              autoFocus
            />
            {error && <p style={{ color: 'var(--danger)', fontSize: '0.875rem' }}>{error}</p>}
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        )}

        {mode === 'supabase' && (
          <form onSubmit={handleSupabaseLogin} className="flex flex-col gap-2">
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {error && <p style={{ color: 'var(--danger)', fontSize: '0.875rem' }}>{error}</p>}
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
