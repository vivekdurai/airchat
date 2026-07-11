import { NextRequest, NextResponse } from 'next/server';
import { getStorageAdapter } from '@/lib/api-v2-auth';
import { isDashboardAuthenticated } from '@/lib/dashboard-auth';

const ADMIN_CTX = {
  agentId: 'dashboard-admin',
  agentName: 'dashboard-admin',
  machineId: 'dashboard',
};

// GET /api/admin/search?q=...&channel=...
export async function GET(request: NextRequest) {
  if (!(await isDashboardAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const q = request.nextUrl.searchParams.get('q')?.trim();
  const channel = request.nextUrl.searchParams.get('channel') ?? undefined;
  if (!q) {
    return NextResponse.json({ error: 'Missing "q" query parameter' }, { status: 400 });
  }
  try {
    const results = await getStorageAdapter().forAgent(ADMIN_CTX).searchMessages(q, channel);
    return NextResponse.json({ results });
  } catch {
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}
