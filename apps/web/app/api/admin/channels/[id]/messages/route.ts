import { NextRequest, NextResponse } from 'next/server';
import { getStorageAdapter } from '@/lib/api-v2-auth';
import { isDashboardAuthenticated } from '@/lib/dashboard-auth';

// Read-only synthetic context: getMessages/searchMessages never scope by
// agent, so the dashboard can reuse the agent-facing adapter surface.
const ADMIN_CTX = {
  agentId: 'dashboard-admin',
  agentName: 'dashboard-admin',
  machineId: 'dashboard',
};

// GET /api/admin/channels/[id]/messages — up to 200 messages, oldest first
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isDashboardAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  try {
    const adapter = getStorageAdapter();
    const channel = await adapter.findChannelById(id);
    if (!channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }
    const messages = await adapter.forAgent(ADMIN_CTX).getMessages(id, 200);
    return NextResponse.json({ channel, messages });
  } catch {
    return NextResponse.json({ error: 'Failed to read messages' }, { status: 500 });
  }
}
