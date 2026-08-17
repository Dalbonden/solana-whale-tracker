import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/ping — liveness probe.
 *
 * Deliberately does no work: no database call, no upstream request, no config
 * validation. It answers exactly one question — "is the server process
 * accepting requests" — which is what a platform health check needs.
 *
 * `/api/health` is the readiness/diagnostic endpoint instead, and it returns
 * 207 when an integration is unconfigured. That is correct for humans and wrong
 * for a health check, which would read 207 as unhealthy and restart the service
 * in a loop.
 */
export async function GET() {
  return NextResponse.json(
    { status: 'ok', timestamp: new Date().toISOString() },
    { headers: { 'cache-control': 'no-store' } }
  );
}
