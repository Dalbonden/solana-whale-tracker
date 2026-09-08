/**
 * In-process scheduler.
 *
 * The app runs as a long-lived Node server, so it can drive its own scheduled
 * work rather than depending on something outside to poke it. That matters more
 * than it sounds: without a scheduler this tracker does not track. Whale
 * activity is only ingested when `sync` runs, cost basis only deepens when
 * `backfill` runs, and `/compounders` has nothing to plot unless `portfolios`
 * has been writing snapshots all along.
 *
 * The alternative — GitHub Actions or an external pinger — works, but it needs
 * two secrets configured by hand in a second system, and a data pipeline that
 * silently does nothing until someone completes an optional setup step is a bad
 * design. This is on by default and needs nothing.
 *
 * ── Catch-up, not clockwork ──
 *
 * Free hosting suspends an idle instance, so this cannot assume it has been
 * running continuously. Instead of firing on a fixed clock it asks a different
 * question each minute: which job is furthest past due? Last-run times come
 * from `job_runs`, which survives restarts, so an instance waking after hours
 * asleep immediately works through what it missed.
 *
 * ── One job at a time ──
 *
 * Discovery takes ~160s and portfolio snapshots ~60s, and both are rate-limited
 * against the same upstream APIs. Running one job per tick means a backlog
 * drains steadily instead of arriving as a thundering herd that trips 429s on
 * every provider at once.
 */

import { config } from '@/lib/config';
import { getRecentJobRuns } from '@/lib/db/repositories';

interface ScheduledJob {
  /** Matches the `job` column in job_runs, minus the `cron.` prefix. */
  name: string;
  path: string;
  everyMinutes: number;
}

/*
 * Cadences mirror what the work is actually for.
 *
 * `portfolios` is hourly because it is the sole source of net-worth history and
 * a trajectory needs three points across a day before it says anything — the
 * interval here is the resolution of that entire feature.
 *
 * `sync` is the most frequent because it is the only thing that notices a whale
 * trading at all, and it doubles as the keep-warm request.
 */
/*
 * Cadence is set by what each job costs on a free API allowance, not by how
 * often fresh data would be nice to have.
 *
 * The original intervals assumed the providers were effectively free. They are
 * not: a month of this schedule exhausted both the Helius credit allowance and
 * Birdeye's compute units, at which point every job fails and the tracker
 * stops entirely. Slower and alive beats fast and dead.
 *
 * `sync` keeps its 15-minute tick because it no longer costs a fixed amount —
 * `sync-cadence` scales each wallet's polling interval by how recently it
 * traded, so a tick with nothing due makes no provider calls at all. The jobs
 * below have no such per-item throttle, so their cost is the interval.
 */
const JOBS: ScheduledJob[] = [
  { name: 'sync', path: '/api/cron/sync', everyMinutes: 15 },
  { name: 'portfolios', path: '/api/cron/portfolios', everyMinutes: 180 },
  { name: 'deepen-traces', path: '/api/cron/deepen-traces?limit=5&pages=4', everyMinutes: 360 },
  { name: 'tokens', path: '/api/cron/tokens', everyMinutes: 240 },
  { name: 'backfill', path: '/api/cron/backfill?limit=3&max=200', everyMinutes: 720 },
  { name: 'discover', path: '/api/cron/discover', everyMinutes: 720 },
  { name: 'webhook-sync', path: '/api/cron/webhook-sync', everyMinutes: 720 },
  { name: 'rebuild-positions', path: '/api/cron/rebuild-positions', everyMinutes: 1440 },
];

const TICK_MS = 60_000;

/*
 * State lives on globalThis rather than in module scope.
 *
 * Next does not guarantee that the instrumentation hook and a route handler
 * share one instance of a module — they are bundled into different server
 * chunks — so module-level state gives each its own copy. That showed up as
 * /api/health reporting "never ran" for jobs the logs proved had just run, and
 * it is the more dangerous half of the same bug: a per-instance `started` flag
 * cannot stop a second scheduler starting in another chunk and doubling every
 * job.
 */
interface SchedulerState {
  started: boolean;
  running: boolean;
  lastRun: Map<string, number>;
}

const GLOBAL_KEY = Symbol.for('solana-whale-tracker.scheduler');

function state(): SchedulerState {
  const host = globalThis as unknown as Record<symbol, SchedulerState | undefined>;
  const existing = host[GLOBAL_KEY];
  if (existing) return existing;

  const fresh: SchedulerState = { started: false, running: false, lastRun: new Map() };
  host[GLOBAL_KEY] = fresh;
  return fresh;
}

function baseUrl(): string {
  // Talk to ourselves over the loopback interface. Going out through the public
  // hostname would leave the platform's router and, on a free instance, could
  // be the request that wakes a container that is already awake.
  const port = process.env.PORT ?? '3000';
  return `http://127.0.0.1:${port}`;
}

/**
 * Seeds last-run times from the database so a restart does not re-run
 * everything, and a long sleep does not leave jobs looking permanently fresh.
 */
async function seedFromHistory(): Promise<void> {
  const { lastRun } = state();
  const intervals = new Map(JOBS.map((job) => [job.name, job.everyMinutes * 60_000]));

  try {
    // Ordered newest-first, so the first row seen for a job is its latest run.
    const runs = await getRecentJobRuns(100);
    const latest = new Map<string, { at: number; failed: boolean }>();

    for (const run of runs) {
      const name = String(run.job).replace(/^cron\./, '');
      const at = Date.parse(String(run.created_at));
      if (!Number.isFinite(at) || latest.has(name)) continue;
      latest.set(name, { at, failed: String(run.status) === 'error' });
    }

    for (const [name, run] of latest) {
      const interval = intervals.get(name);

      /*
       * A failed run is seeded as due again shortly, not as a completed cycle.
       *
       * The in-process retry cannot carry this on its own: a free Render
       * instance spins down when idle, so the process holding that timer
       * usually dies before the retry fires. Without this, a job that failed
       * once waits its entire interval measured from the failure — which is how
       * webhook-sync came to sit twelve hours away from repairing a
       * subscription that was actively draining the API allowance.
       */
      const effective =
        run.failed && interval && interval > RETRY_AFTER_FAILURE_MS
          ? run.at - interval + RETRY_AFTER_FAILURE_MS
          : run.at;

      if (!lastRun.has(name) || effective > (lastRun.get(name) ?? 0)) {
        lastRun.set(name, effective);
      }
    }
  } catch (error) {
    // No history is survivable: everything simply looks due, and the one-job
    // -per-tick rule spreads the catch-up out anyway.
    console.warn('[scheduler] could not read job history:', (error as Error).message);
  }
}

/** The job furthest past its interval, or null when nothing is due. */
function mostOverdue(now: number): ScheduledJob | null {
  const { lastRun } = state();
  let pick: ScheduledJob | null = null;
  let worst = 0;

  for (const job of JOBS) {
    const due = (lastRun.get(job.name) ?? 0) + job.everyMinutes * 60_000;
    const overdueBy = now - due;
    if (overdueBy < 0) continue;
    if (overdueBy > worst || pick === null) {
      worst = overdueBy;
      pick = job;
    }
  }

  return pick;
}

/**
 * How soon a failed job is retried, rather than waiting its whole interval.
 *
 * Recording the run before the call is right — it stops a job that dies
 * mid-run being retried every tick — but it also meant a *failed* run consumed
 * the full interval. On the twelve-hourly jobs that is severe: webhook-sync
 * failed once because a provider was briefly refusing calls, and the
 * subscription it exists to repair would then have stayed broken for twelve
 * hours, generating the very load that caused the failure.
 */
const RETRY_AFTER_FAILURE_MS = 15 * 60_000;

/** Rewinds a job's clock so a failure is retried soon instead of next cycle. */
function scheduleRetry(job: ScheduledJob, now: number): void {
  const interval = job.everyMinutes * 60_000;
  // Frequent jobs already come round sooner than the retry delay.
  if (interval <= RETRY_AFTER_FAILURE_MS) return;
  state().lastRun.set(job.name, now + RETRY_AFTER_FAILURE_MS - interval);
  console.warn(
    `[scheduler] ${job.name} will retry in ${RETRY_AFTER_FAILURE_MS / 60_000}m rather than ${job.everyMinutes}m`
  );
}

async function tick(): Promise<void> {
  const current = state();
  if (current.running) return;

  const job = mostOverdue(Date.now());
  if (!job) return;

  current.running = true;
  // Recorded before the call, not after: a job that dies mid-run must not be
  // retried every single tick.
  current.lastRun.set(job.name, Date.now());

  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl()}${job.path}`, {
      headers: { Authorization: `Bearer ${config.auth.cronSecret}` },
      cache: 'no-store',
    });

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (response.ok) {
      console.log(`[scheduler] ${job.name} ok in ${seconds}s`);
    } else {
      console.warn(`[scheduler] ${job.name} returned ${response.status} after ${seconds}s`);
      scheduleRetry(job, Date.now());
    }
  } catch (error) {
    console.warn(`[scheduler] ${job.name} failed:`, (error as Error).message);
    scheduleRetry(job, Date.now());
  } finally {
    current.running = false;
  }
}

export function schedulerEnabled(): boolean {
  const flag = (process.env.SCHEDULER ?? '').toLowerCase();
  if (flag === 'off' || flag === 'false' || flag === '0') return false;
  if (flag === 'on' || flag === 'true' || flag === '1') return true;

  // Default: on when deployed and able to authenticate against its own routes.
  // Off in development, where an unattended scheduler would quietly burn the
  // free tier of every upstream API while someone edits a component.
  return config.app.isProd && Boolean(config.auth.cronSecret);
}

export function startScheduler(): void {
  const current = state();
  if (current.started || !schedulerEnabled()) return;
  current.started = true;

  console.log('[scheduler] starting — jobs:', JOBS.map((j) => `${j.name}/${j.everyMinutes}m`).join(' '));

  void seedFromHistory().then(() => {
    // First tick shortly after boot rather than immediately: the HTTP server
    // has to be accepting connections before it can call itself.
    setTimeout(() => void tick(), 10_000);
  });

  const timer = setInterval(() => void tick(), TICK_MS);
  // Never hold the process open on this alone.
  timer.unref?.();
}

/** Current state, for `/api/health`. */
export function schedulerStatus(): {
  enabled: boolean;
  running: boolean;
  jobs: Array<{ name: string; everyMinutes: number; lastRunAt: string | null; dueInMinutes: number }>;
} {
  const now = Date.now();
  const current = state();
  return {
    enabled: schedulerEnabled(),
    running: current.running,
    jobs: JOBS.map((job) => {
      const last = current.lastRun.get(job.name) ?? null;
      const due = (last ?? 0) + job.everyMinutes * 60_000;
      return {
        name: job.name,
        everyMinutes: job.everyMinutes,
        lastRunAt: last ? new Date(last).toISOString() : null,
        dueInMinutes: Math.round((due - now) / 60_000),
      };
    }),
  };
}
