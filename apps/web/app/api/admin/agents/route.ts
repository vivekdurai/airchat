import { NextRequest, NextResponse } from 'next/server';
import { getStorageAdapter } from '@/lib/api-v2-auth';
import { isDashboardAuthenticated } from '@/lib/dashboard-auth';

// GET /api/admin/agents — all agents, full rows minus credentials
export async function GET() {
  if (!(await isDashboardAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const agents = await getStorageAdapter().listAgentsAdmin();
    return NextResponse.json({
      agents: agents.map(({ id, name, description, active, created_at, last_seen_at }) => ({
        id, name, description, active, created_at, last_seen_at,
      })),
    });
  } catch {
    return NextResponse.json({ error: 'Failed to list agents' }, { status: 500 });
  }
}

// PATCH /api/admin/agents — { id, active }
export async function PATCH(request: NextRequest) {
  if (!(await isDashboardAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let id: unknown, active: unknown;
  try {
    ({ id, active } = await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof id !== 'string' || typeof active !== 'boolean') {
    return NextResponse.json({ error: 'id (string) and active (boolean) required' }, { status: 400 });
  }
  try {
    await getStorageAdapter().setAgentActive(id, active);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Failed to update agent' }, { status: 500 });
  }
}
