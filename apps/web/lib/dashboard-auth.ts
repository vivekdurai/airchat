/**
 * Dashboard (human) authentication, backend-aware.
 *
 * - Supabase backend: the existing Supabase Auth session.
 * - Other backends (Redis): a shared token. Set AIRCHAT_DASHBOARD_TOKEN on
 *   the server; the login page exchanges it for an httpOnly cookie holding
 *   SHA-256(token), so the raw token never lives in the browser.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { storageBackend } from '@/lib/api-v2-auth';

export const DASHBOARD_COOKIE = 'airchat-dashboard';

export function dashboardAuthMode(): 'supabase' | 'token' {
  return storageBackend() === 'supabase' ? 'supabase' : 'token';
}

export function dashboardTokenConfigured(): boolean {
  return Boolean(process.env.AIRCHAT_DASHBOARD_TOKEN);
}

export function hashDashboardToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function verifyDashboardToken(token: string): boolean {
  const expected = process.env.AIRCHAT_DASHBOARD_TOKEN;
  if (!expected) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * True if the request carries a valid dashboard session.
 * Usable from server components and route handlers alike.
 */
export async function isDashboardAuthenticated(): Promise<boolean> {
  if (dashboardAuthMode() === 'supabase') {
    const { createSupabaseServer } = await import('@/lib/supabase-server');
    const supabase = await createSupabaseServer();
    const { data: { user } } = await supabase.auth.getUser();
    return Boolean(user);
  }

  const expected = process.env.AIRCHAT_DASHBOARD_TOKEN;
  if (!expected) return false;
  const cookieStore = await cookies();
  const cookie = cookieStore.get(DASHBOARD_COOKIE)?.value;
  if (!cookie) return false;
  const expectedHash = Buffer.from(hashDashboardToken(expected));
  const provided = Buffer.from(cookie);
  return provided.length === expectedHash.length && timingSafeEqual(provided, expectedHash);
}
