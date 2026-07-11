import { NextResponse } from 'next/server';
import { getStorageAdapter } from '@/lib/api-v2-auth';
import { isDashboardAuthenticated } from '@/lib/dashboard-auth';

// GET /api/admin/channels — all channels (dashboard sidebar / index)
export async function GET() {
  if (!(await isDashboardAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const channels = await getStorageAdapter().listAllChannels();
    return NextResponse.json({ channels });
  } catch {
    return NextResponse.json({ error: 'Failed to list channels' }, { status: 500 });
  }
}
