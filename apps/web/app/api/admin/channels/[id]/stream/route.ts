import { NextRequest } from 'next/server';
import { supportsRealtime } from '@airchat/shared';
import { getStorageAdapter } from '@/lib/api-v2-auth';
import { isDashboardAuthenticated } from '@/lib/dashboard-auth';

// GET /api/admin/channels/[id]/stream — Server-Sent Events feed of new
// messages in a channel, backed by RealtimeStorage (Redis Streams).
//
// Emits one `message` event per new message and a comment heartbeat when a
// blocking read times out with nothing new. Backends without realtime
// support return 501; the dashboard falls back to polling.

export const dynamic = 'force-dynamic';

const BLOCK_MS = 15_000;
const encoder = new TextEncoder();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isDashboardAuthenticated())) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const adapter = getStorageAdapter();
  if (!supportsRealtime(adapter)) {
    return Response.json(
      { error: 'Realtime is not supported by this storage backend' },
      { status: 501 }
    );
  }

  const { id } = await params;
  const channel = await adapter.findChannelById(id);
  if (!channel) {
    return Response.json({ error: 'Channel not found' }, { status: 404 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // '$' = only messages that arrive after the client connects; the
      // client already has history from the regular messages endpoint.
      let cursor = '$';
      try {
        while (!request.signal.aborted) {
          const { lastId, messages } = await adapter.waitForChannelMessages(
            id,
            cursor,
            BLOCK_MS
          );
          cursor = lastId;
          if (request.signal.aborted) break;
          if (messages.length) {
            for (const message of messages) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(message)}\n\n`)
              );
            }
          } else {
            // Heartbeat comment keeps proxies from closing the connection.
            controller.enqueue(encoder.encode(': ping\n\n'));
          }
        }
      } catch {
        // Client disconnected mid-write or the backend went away; either
        // way the stream is done.
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
