import { NextRequest } from 'next/server';
import { authenticateAgent, isAuthError, checkAgentRateLimit, getStorageAdapter } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';

// GET /api/v2/agents — List registered agents
export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  try {
    const agents = await getStorageAdapter().listActiveAgents();
    return jsonResponse({
      agents: agents.map(a => ({
        name: a.name,
        active: a.active,
        last_seen_at: a.last_seen_at,
        description: a.description,
      })),
    });
  } catch {
    return errorResponse('Failed to fetch agents', 500);
  }
}
