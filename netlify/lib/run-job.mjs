/**
 * Shared body for the scheduled functions.
 *
 * Each function under `netlify/functions/` is a thin wrapper that names one
 * cron route and a schedule; Netlify's cron invokes it, and this calls the
 * corresponding App Router endpoint with the shared secret.
 *
 * WHY THE JOBS ARE INVOKED WITH SMALL LIMITS
 *
 * On Render these routes ran inside a long-lived process and declared
 * `maxDuration = 300`. A Netlify function does not get anywhere near that — the
 * synchronous limit is measured in seconds, and it applies to the cron route
 * itself, not just to this caller. A portfolio run that took 56 seconds on
 * Render will simply be killed here.
 *
 * So every job is invoked with a small batch size and run more often instead.
 * All of them are already resumable — sync walks from a stored cursor,
 * backfill from its own, deepen-traces from the trace cache — so a small batch
 * is progress rather than a partial result.
 */

/** Resolves the site's own origin from whatever Netlify exposes. */
export function siteUrl() {
  return (
    process.env.APP_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.DEPLOY_URL ||
    ''
  ).replace(/\/$/, '');
}

/**
 * Calls one cron route.
 *
 * Always resolves. A scheduled function that throws is retried by Netlify, and
 * for these jobs a retry is worse than a skip: the next tick comes round soon
 * and every job is resumable, whereas a retry storm against an already
 * rate-limited provider is how the API allowances were exhausted before.
 */
export async function runJob(path) {
  const base = siteUrl();
  const secret = process.env.CRON_SECRET;

  if (!base) {
    console.error('[scheduled] no site URL available; set APP_URL');
    return new Response('missing site url', { status: 500 });
  }
  if (!secret) {
    console.error('[scheduled] CRON_SECRET is not set; refusing to call an unauthenticated job');
    return new Response('missing CRON_SECRET', { status: 500 });
  }

  const target = `${base}${path}`;
  const started = Date.now();

  try {
    const response = await fetch(target, {
      headers: { Authorization: `Bearer ${secret}` },
      // These write to the database; a cached response would be meaningless.
      cache: 'no-store',
    });

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const body = await response.text().catch(() => '');
    console.log(`[scheduled] ${path} -> ${response.status} in ${seconds}s ${body.slice(0, 300)}`);

    // Report success to Netlify regardless: the job records its own outcome in
    // `job_runs`, and that is the log worth reading.
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error(`[scheduled] ${path} failed:`, error?.message ?? error);
    return new Response(null, { status: 204 });
  }
}
