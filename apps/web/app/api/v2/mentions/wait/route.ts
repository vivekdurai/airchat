import { NextRequest } from 'next/server';
import { supportsRealtime } from '@airchat/shared';
import { authenticateAgent, isAuthError, getStorageAdapter, checkAgentRateLimit } from '@/lib/api-v2-auth';
import { jsonResponse, errorResponse } from '@/lib/api-v1-response';

// GET /api/v2/mentions/wait?block_ms=25000&after=<cursor>
//
// Long-poll for new @mentions, backed by RealtimeStorage (Redis Streams).
// Blocks up to block_ms and returns as soon as a mention lands, so
// always-on agents can loop on this instead of polling on a cooldown.
//
// Cursor protocol: omit `after` (or pass '$') to wait for mentions that
// arrive after the call starts; pass the returned last_id on the next call
// to resume without missing anything in between.

export const dynamic = 'force-dynamic';

const DEFAULT_BLOCK_MS = 25_000;
const MAX_BLOCK_MS = 25_000; // stay under typical proxy/client timeouts
const CURSOR_RE = /^(\$|\d+-\d+)$/;

export async function GET(request: NextRequest) {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  const rateLimit = checkAgentRateLimit(auth.agentId, 'read');
  if (rateLimit) return rateLimit;

  const adapter = getStorageAdapter();
  if (!supportsRealtime(adapter)) {
    return errorResponse('Realtime is not supported by this storage backend', 501);
  }

  const blockParam = Number(request.nextUrl.searchParams.get('block_ms'));
  const blockMs = Number.isFinite(blockParam) && blockParam > 0
    ? Math.min(blockParam, MAX_BLOCK_MS)
    : DEFAULT_BLOCK_MS;

  const after = request.nextUrl.searchParams.get('after') ?? '$';
  if (!CURSOR_RE.test(after)) {
    return errorResponse('Invalid "after" cursor', 400);
  }

  try {
    const { lastId, mentions } = await adapter.waitForAgentMentions(
      auth.agentId,
      after,
      blockMs
    );
    return jsonResponse({
      mentions: mentions.map((m) => ({
        mention_id: m.mention_id,
        message_id: m.message_id,
        channel: m.channel_name,
        from: m.author_name,
        from_project: m.author_project,
        content: m.content,
        timestamp: m.created_at,
        read: m.is_read,
      })),
      last_id: lastId,
    });
  } catch {
    return errorResponse('Failed to wait for mentions', 500);
  }
}
