import { NextRequest, NextResponse } from 'next/server';
import {
  DASHBOARD_COOKIE,
  dashboardAuthMode,
  dashboardTokenConfigured,
  hashDashboardToken,
  verifyDashboardToken,
} from '@/lib/dashboard-auth';

// GET /api/admin/login — which login flow the dashboard should render
export async function GET() {
  return NextResponse.json({
    mode: dashboardAuthMode(),
    enabled: dashboardAuthMode() === 'supabase' || dashboardTokenConfigured(),
  });
}

// POST /api/admin/login — token mode only: exchange token for a session cookie
export async function POST(request: NextRequest) {
  if (dashboardAuthMode() !== 'token') {
    return NextResponse.json({ error: 'Token login is not enabled on this server' }, { status: 400 });
  }
  if (!dashboardTokenConfigured()) {
    return NextResponse.json(
      { error: 'Dashboard login is disabled. Set AIRCHAT_DASHBOARD_TOKEN on the server.' },
      { status: 503 }
    );
  }

  let token: unknown;
  try {
    ({ token } = await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof token !== 'string' || !verifyDashboardToken(token)) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 403 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(DASHBOARD_COOKIE, hashDashboardToken(token), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
