/**
 * Server startup hook.
 *
 * Next calls `register()` once per server process, which is the only place the
 * app can start background work without tying it to a request.
 */
export async function register(): Promise<void> {
  // This module is also evaluated in the edge runtime, where timers and
  // loopback fetch do not behave the way the scheduler needs.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { startScheduler } = await import('@/lib/core/scheduler');
  startScheduler();
}
