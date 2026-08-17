/**
 * Central runtime configuration.
 *
 * Every value is read once here so that a missing key produces one clear error
 * at the call site instead of an opaque 401 from a downstream API.
 */

function optional(key: string, fallback = ''): string {
  return process.env[key]?.trim() || fallback;
}

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Throws with an actionable message when a server-only secret is missing. */
export function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable ${key}. ` +
        `Add it to .env.local (dev) or Vercel → Settings → Environment Variables (prod). ` +
        `See .env.example.`
    );
  }
  return value;
}

export const config = {
  app: {
    /**
     * Public origin of this deployment, used to register the Helius webhook.
     *
     * Resolved at *runtime*, in preference order, because `NEXT_PUBLIC_*` is
     * inlined at build time — and on hosts that assign the URL when the service
     * is created (Render, Railway), that value is not knowable during the build.
     * `APP_URL` and the host-injected variables are plain server env vars, so
     * they are read fresh on every call.
     */
    get url(): string {
      return (
        optional('APP_URL') ||
        optional('RENDER_EXTERNAL_URL') ||
        (optional('VERCEL_PROJECT_PRODUCTION_URL')
          ? `https://${optional('VERCEL_PROJECT_PRODUCTION_URL')}`
          : '') ||
        optional('NEXT_PUBLIC_APP_URL') ||
        'http://localhost:3000'
      );
    },
    isProd: process.env.NODE_ENV === 'production',
  },

  solana: {
    /** Falls back to Helius-from-key, then to the public endpoint (heavily rate limited). */
    get rpcUrl(): string {
      const explicit = optional('SOLANA_RPC_URL');
      if (explicit && !explicit.includes('YOUR_HELIUS_KEY')) return explicit;
      const key = optional('HELIUS_API_KEY');
      if (key) return `https://mainnet.helius-rpc.com/?api-key=${key}`;
      return 'https://api.mainnet-beta.solana.com';
    },
    heliusApiKey: optional('HELIUS_API_KEY'),
    get hasHelius(): boolean {
      return Boolean(optional('HELIUS_API_KEY'));
    },
  },

  birdeye: {
    apiKey: optional('BIRDEYE_API_KEY'),
    baseUrl: 'https://public-api.birdeye.so',
    get enabled(): boolean {
      return Boolean(optional('BIRDEYE_API_KEY'));
    },
  },

  solscan: {
    apiKey: optional('SOLSCAN_API_KEY'),
    baseUrl: 'https://pro-api.solscan.io/v2.0',
    get enabled(): boolean {
      return Boolean(optional('SOLSCAN_API_KEY'));
    },
  },

  pumpfun: {
    baseUrl: optional('PUMPFUN_API_URL', 'https://frontend-api.pump.fun'),
  },

  supabase: {
    url: optional('NEXT_PUBLIC_SUPABASE_URL'),
    anonKey: optional('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    serviceRoleKey: optional('SUPABASE_SERVICE_ROLE_KEY'),
    get enabled(): boolean {
      return Boolean(optional('NEXT_PUBLIC_SUPABASE_URL') && optional('SUPABASE_SERVICE_ROLE_KEY'));
    },
  },

  auth: {
    cronSecret: optional('CRON_SECRET'),
    webhookSecret: optional('HELIUS_WEBHOOK_SECRET'),
  },

  /**
   * Whale detection thresholds. A wallet must clear the portfolio floor AND at
   * least one of the activity signals — see `src/lib/core/whale-detection.ts`.
   */
  detection: {
    minPortfolioUsd: num('WHALE_MIN_PORTFOLIO_USD', 250_000),
    minTradeUsd: num('WHALE_MIN_TRADE_USD', 25_000),
    minMemeExposure: num('WHALE_MIN_MEME_EXPOSURE', 0.15),
    minTrades30d: num('WHALE_MIN_TRADES_30D', 8),
    /** Score floor (0..100) below which a candidate is not persisted. */
    minScore: num('WHALE_MIN_SCORE', 45),
  },

  alerts: {
    largeTradeUsd: num('ALERT_LARGE_TRADE_USD', 50_000),
    clusterWhales: num('ALERT_CLUSTER_WHALES', 3),
    clusterWindowMinutes: num('ALERT_CLUSTER_WINDOW_MINUTES', 60),
    /** A buy within this many minutes of a pump.fun launch counts as a snipe. */
    snipeWindowMinutes: num('ALERT_SNIPE_WINDOW_MINUTES', 15),
    /** Sell that leaves < this fraction of the position counts as a full exit. */
    fullExitResidual: num('ALERT_FULL_EXIT_RESIDUAL', 0.05),
    /** Rotation = full exit + new position inside this window. */
    rotationWindowMinutes: num('ALERT_ROTATION_WINDOW_MINUTES', 180),
  },

  limits: {
    /** Max whale wallets synced per cron invocation (Vercel function timeout). */
    whalesPerSync: num('SYNC_WHALES_PER_RUN', 25),
    /** Max transactions pulled per whale per sync. */
    txPerWhale: num('SYNC_TX_PER_WHALE', 100),
    /** Max candidate wallets evaluated per discovery run. */
    discoveryCandidates: num('DISCOVERY_CANDIDATES_PER_RUN', 120),
  },
} as const;

/**
 * Reports which integrations are wired up. Surfaced on the dashboard so a
 * half-configured deployment is obvious rather than silently empty.
 */
export function integrationStatus() {
  return {
    supabase: config.supabase.enabled,
    helius: config.solana.hasHelius,
    birdeye: config.birdeye.enabled,
    solscan: config.solscan.enabled,
    webhook: Boolean(config.auth.webhookSecret),
    cron: Boolean(config.auth.cronSecret),
  };
}
