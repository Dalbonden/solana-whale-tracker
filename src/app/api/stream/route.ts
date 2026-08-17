import { listAlerts, listTrades } from '@/lib/db/repositories';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/stream — Server-Sent Events feed of new trades and alerts.
 *
 * Why SSE over a websocket: Vercel's serverless functions cannot hold a
 * websocket, but they can stream a response. The client (`useLiveFeed`) keeps
 * an `EventSource` open, and reconnects automatically when the function hits
 * its duration limit — SSE has built-in reconnect with `Last-Event-ID`, so the
 * cursor survives the reconnect and no events are dropped.
 *
 * The stream polls the database rather than subscribing to it. That keeps the
 * dependency surface small (no Supabase Realtime channel to configure) and the
 * poll is a single indexed query on `created_at`.
 */

const POLL_INTERVAL_MS = 4_000;
/** Close a little before maxDuration so the client reconnects cleanly. */
const STREAM_LIFETIME_MS = 50_000;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const lastEventId = request.headers.get('last-event-id');
  const initialCursor =
    lastEventId ?? url.searchParams.get('since') ?? new Date(Date.now() - 60_000).toISOString();

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      let cursor = initialCursor;
      const startedAt = Date.now();

      const send = (event: string, data: unknown, id?: string) => {
        if (closed) return;
        const lines = [
          id ? `id: ${id}` : '',
          `event: ${event}`,
          `data: ${JSON.stringify(data)}`,
          '',
          '',
        ]
          .filter((line, index) => line !== '' || index > 0)
          .join('\n');
        controller.enqueue(encoder.encode(lines));
      };

      // Tell the client how long to wait before reconnecting.
      controller.enqueue(encoder.encode('retry: 3000\n\n'));
      send('connected', { cursor, at: new Date().toISOString() });

      const tick = async () => {
        if (closed) return;

        try {
          const [trades, alerts] = await Promise.all([
            listTrades({ since: cursor, pageSize: 50 }),
            listAlerts({ since: cursor, pageSize: 50 }),
          ]);

          // Advance the cursor before emitting, so a client that reconnects
          // mid-batch resumes after what it already received.
          // ISO-8601 sorts correctly as a string, so this is just "the latest".
          const timestamps = [
            ...trades.rows.map((trade) => trade.created_at),
            ...alerts.rows.map((alert) => alert.created_at),
          ].sort();
          const newest = timestamps[timestamps.length - 1];
          if (newest && newest > cursor) cursor = newest;

          if (trades.rows.length) send('trades', trades.rows, cursor);
          if (alerts.rows.length) send('alerts', alerts.rows, cursor);
          if (!trades.rows.length && !alerts.rows.length) {
            // Heartbeat: keeps proxies from closing an idle connection.
            controller.enqueue(encoder.encode(': keepalive\n\n'));
          }
        } catch (error) {
          send('error', { message: (error as Error).message });
        }
      };

      await tick();

      const interval = setInterval(async () => {
        if (closed) return;
        if (Date.now() - startedAt > STREAM_LIFETIME_MS) {
          clearInterval(interval);
          send('reconnect', { cursor });
          closed = true;
          controller.close();
          return;
        }
        await tick();
      }, POLL_INTERVAL_MS);

      request.signal.addEventListener('abort', () => {
        closed = true;
        clearInterval(interval);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },

    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Disable proxy buffering; without it events arrive in bursts.
      'x-accel-buffering': 'no',
    },
  });
}
