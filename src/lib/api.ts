/**
 * Shared helpers for route handlers: consistent JSON envelopes, query parsing
 * and job authentication.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { config } from '@/lib/config';

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, {
    ...init,
    headers: { 'cache-control': 'no-store', ...init?.headers },
  });
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error: message, ...extra }, { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * Converts a thrown error into a response. Configuration mistakes (missing env
 * vars) return 503 with the actionable message rather than a generic 500 —
 * that message is the whole point of `config.required`.
 */
export function handleError(error: unknown, context: string): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[api:${context}]`, message);

  if (message.includes('Missing required environment variable') || message.includes('not configured')) {
    return fail(message, 503, { context, hint: 'See README.md § Configuration' });
  }
  return fail(`${context} failed`, 500, { detail: message });
}

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export function searchParamsToObject(url: string): Record<string, string> {
  const params = new URL(url).searchParams;
  const out: Record<string, string> = {};
  for (const [key, value] of params) if (value !== '') out[key] = value;
  return out;
}

export function listResponse<T>(rows: T[], count: number, page: number, pageSize: number) {
  return {
    data: rows,
    count,
    page,
    pageSize,
    hasMore: page * pageSize < count,
  };
}

/**
 * Guards cron endpoints. Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
 *
 * If CRON_SECRET is unset the route is refused rather than left open — an
 * unauthenticated endpoint that burns paid RPC credits is not an acceptable
 * default.
 */
export function authorizeJob(request: Request): { ok: true } | { ok: false; response: NextResponse } {
  const secret = config.auth.cronSecret;
  if (!secret) {
    return {
      ok: false,
      response: fail(
        'CRON_SECRET is not set; job endpoints are disabled. Set it in your environment to enable scheduled jobs.',
        503
      ),
    };
  }

  const header = request.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : header;

  if (!timingSafeEqual(provided, secret)) {
    return { ok: false, response: fail('Unauthorized', 401) };
  }
  return { ok: true };
}

/** Constant-time comparison; secrets should not be compared with `===`. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Wraps a job handler with timing, error capture and a run record. */
export async function runJob<T extends Record<string, unknown>>(
  name: string,
  handler: () => Promise<T>
): Promise<NextResponse> {
  const started = Date.now();
  const { recordJobRun } = await import('@/lib/db/repositories');

  try {
    const result = await handler();
    const durationMs = Date.now() - started;
    await recordJobRun({
      job: name,
      status: 'ok',
      durationMs,
      processed: Number(result.processed ?? 0),
      created: Number(result.created ?? 0),
      detail: result,
    });
    return ok({ job: name, status: 'ok', durationMs, ...result });
  } catch (error) {
    const durationMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    await recordJobRun({
      job: name,
      status: 'error',
      durationMs,
      detail: { error: message },
    }).catch(() => undefined);
    console.error(`[job:${name}]`, message);
    return fail(`job ${name} failed`, 500, { detail: message, durationMs });
  }
}
