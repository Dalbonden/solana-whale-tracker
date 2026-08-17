# Deploying to Vercel

Full walkthrough from an empty repo to a running tracker with real-time alerts.

---

## 1. Provision Supabase

1. Create a project at <https://supabase.com/dashboard>.
2. **SQL Editor** → paste `supabase/schema.sql` → **Run**.
3. **SQL Editor** → paste `supabase/seed.sql` → **Run**.
4. **Project Settings → API**, copy:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` `public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` `secret` key → `SUPABASE_SERVICE_ROLE_KEY`

Verify the schema landed:

```sql
select count(*) from public.meme_tokens;   -- expect 10
select table_name from information_schema.tables
where table_schema = 'public' order by 1;
-- alerts, job_runs, meme_tokens, whale_portfolios, whale_trades, whales
```

RLS is enabled on every table with **no anon policies**. All access goes through server code using the service role key, so a leaked anon key reads nothing. If you later want the browser to read directly (e.g. Supabase Realtime), uncomment the SELECT policy block at the bottom of `schema.sql`.

---

## 2. Get RPC and market-data keys

### Helius (required)

1. Sign up at <https://dashboard.helius.dev>.
2. Copy the API key → `HELIUS_API_KEY`.
3. Set `SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`.

Helius is strongly recommended over a bare RPC. Two things depend on it:

- **Enhanced transactions** (`/v0/addresses/:address/transactions`) return pre-parsed per-account token balance changes. Without them you would need to decode every AMM instruction layout by hand.
- **Webhooks** push whale transactions the instant they confirm. Without them the tracker still works, but latency is however often the sync cron runs.

The free tier (10M credits/month) is enough to track ~50 whales with 5-minute polling. Add whales or lower the interval and you will need a paid plan.

### Birdeye (required for USD values)

1. Sign up at <https://bds.birdeye.so>.
2. Copy the key → `BIRDEYE_API_KEY`.

Free tier covers prices and metadata. OHLCV charts and `top_traders` (the main discovery source) are rate-limited hard on free — the Standard plan is worth it if discovery keeps returning nothing.

### Solscan Pro (optional)

Only used for exchange/market-maker labels and history backfill. Everything degrades gracefully without it — `isInstitutionalAccount` simply returns `false`, meaning CEX wallets may occasionally slip into the whale list.

---

## 3. Deploy

```bash
git init
git add .
git commit -m "Initial commit"
gh repo create solana-whale-tracker --private --source=. --push
```

Then <https://vercel.com/new> → import the repo. Vercel auto-detects Next.js; no build settings to change.

Or from the CLI:

```bash
npm i -g vercel
vercel          # preview
vercel --prod   # production
```

---

## 4. Environment variables

**Vercel → Project → Settings → Environment Variables.** Add every key for **Production**, **Preview** and **Development**:

| Variable | Value |
| --- | --- |
| `HELIUS_API_KEY` | from Helius |
| `SOLANA_RPC_URL` | `https://mainnet.helius-rpc.com/?api-key=...` |
| `BIRDEYE_API_KEY` | from Birdeye |
| `SOLSCAN_API_KEY` | optional |
| `NEXT_PUBLIC_SUPABASE_URL` | from Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | from Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | from Supabase — **server only** |
| `CRON_SECRET` | `openssl rand -hex 32` |
| `HELIUS_WEBHOOK_SECRET` | `openssl rand -hex 32` |
| `NEXT_PUBLIC_APP_URL` | `https://your-project.vercel.app` |

Redeploy after adding them — Next.js inlines `NEXT_PUBLIC_*` at build time, so they do not take effect until the next build.

Confirm with:

```bash
curl https://your-project.vercel.app/api/health | jq
```

```json
{
  "status": "ok",
  "configured": {
    "supabase": true, "helius": true, "birdeye": true,
    "solscan": false, "webhook": true, "cron": true
  },
  "checks": { "database": { "ok": true }, "birdeye": { "ok": true } }
}
```

---

## 5. Cron jobs

`vercel.json` already declares the schedule:

| Path | Schedule | Purpose |
| --- | --- | --- |
| `/api/cron/sync` | every 5 min | poll whale activity (webhook backstop) |
| `/api/cron/tokens` | every 2 h | refresh market data, admit new tokens |
| `/api/cron/portfolios` | every 3 h | snapshot holdings, rescore whales |
| `/api/cron/discover` | every 6 h | find new whales |
| `/api/cron/webhook-sync` | every 6 h | keep the webhook subscription current |

Vercel injects `Authorization: Bearer $CRON_SECRET` automatically once `CRON_SECRET` is set as an env var. Nothing else to configure.

> ### Hobby plan limitation
>
> **Vercel Hobby allows at most 2 cron jobs, each running at most once per day.** The schedule above needs Pro.
>
> On Hobby, either:
>
> - **Rely on the Helius webhook** for real-time ingest (it is not a cron, so it is unaffected), and cut `vercel.json` down to two daily entries — `/api/cron/discover` and `/api/cron/portfolios`; or
> - **Trigger the jobs externally** from GitHub Actions, cron-job.org or Upstash QStash:
>
> ```yaml
> # .github/workflows/sync.yml
> name: sync
> on:
>   schedule: [{ cron: '*/10 * * * *' }]
>   workflow_dispatch:
> jobs:
>   sync:
>     runs-on: ubuntu-latest
>     steps:
>       - run: |
>           curl -fsS -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" \
>             "${{ secrets.APP_URL }}/api/cron/sync"
> ```

Also note **function duration limits**: cron routes declare `maxDuration = 300`, which requires Pro. On Hobby the ceiling is 60s — lower `SYNC_WHALES_PER_RUN` and `DISCOVERY_CANDIDATES_PER_RUN` so each run finishes in time.

---

## 6. Real-time webhook

Once deployed, register the webhook:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://your-project.vercel.app/api/cron/webhook-sync
```

This creates (or updates) a Helius webhook pointing at `/api/webhooks/helius`, subscribed to every tracked whale address, authenticated with `HELIUS_WEBHOOK_SECRET`.

Re-run it after any discovery pass adds new whales — or leave it to the 6-hourly cron, which does exactly that.

Verify in the [Helius dashboard](https://dashboard.helius.dev/webhooks): one webhook, your URL, address count matching your whale count.

**Manual alternative:** Helius dashboard → Webhooks → Create.

| Field | Value |
| --- | --- |
| Webhook URL | `https://your-project.vercel.app/api/webhooks/helius` |
| Webhook type | Enhanced |
| Transaction types | `SWAP`, `TRANSFER`, `UNKNOWN` |
| Auth header | your `HELIUS_WEBHOOK_SECRET` |
| Account addresses | your whale addresses |

---

## 7. First run

```bash
CRON_SECRET=your_secret \
  node scripts/bootstrap.mjs https://your-project.vercel.app
```

Runs every job in dependency order. Expect 3–8 minutes, most of it in discovery.

Or manually:

```bash
BASE=https://your-project.vercel.app
AUTH="Authorization: Bearer $CRON_SECRET"

curl -H "$AUTH" "$BASE/api/cron/tokens"       # build the universe first
curl -H "$AUTH" "$BASE/api/cron/discover"     # then find whales in it
curl -H "$AUTH" "$BASE/api/cron/sync"         # then ingest their trades
curl -H "$AUTH" "$BASE/api/cron/portfolios"   # then value their holdings
curl -H "$AUTH" "$BASE/api/cron/webhook-sync" # finally go real-time
```

Order matters: discovery searches *within* the token universe, and sync only has whales to poll once discovery has found some.

---

## 8. Verify

```bash
curl "$BASE/api/whales?pageSize=5" | jq '.count'
curl "$BASE/api/trades?hours=24" | jq '.count'
curl "$BASE/api/alerts?hours=24" | jq '.summary'
curl "$BASE/api/tokens?view=leaderboard" | jq '.data[0]'
```

The live feed is easiest to check in the browser — open the dashboard and look for the green **Live** badge on the activity panel. `curl -N "$BASE/api/stream"` also works and should emit a `connected` event immediately, then `: keepalive` every few seconds.

---

## Troubleshooting

**`/api/health` returns 503 / "Missing required environment variable"**
The variable is not set for that environment, or you have not redeployed since adding it.

**Discovery finds zero whales**
Usually thresholds, not a bug. Check the response body — `rejectedSample` lists why each candidate failed. On a quiet market $250K + 15% meme exposure is genuinely restrictive; try `WHALE_MIN_PORTFOLIO_USD=100000` and `WHALE_MIN_MEME_EXPOSURE=0.08`. If every candidate reports `no market data available`, Birdeye is rate-limiting you.

**Trades appear but every `usd_value` is 0**
Birdeye returned no price for the quote *and* traded mint. Confirm `BIRDEYE_API_KEY` is set in the same environment the cron runs in, and check `/api/health` → `checks.birdeye`.

**No alerts despite trades**
Alerts only fire on *newly inserted* trades. A backfill that stored 500 historical trades generates alerts once; re-running the same sync generates none, by design. Also check `ALERT_LARGE_TRADE_USD` is not set above every trade you have.

**Webhook returns 401**
`HELIUS_WEBHOOK_SECRET` in Vercel does not match the `authHeader` registered with Helius. Re-run `/api/cron/webhook-sync` after fixing the env var.

**Cron returns 401**
`CRON_SECRET` is unset or mismatched. Vercel Cron sends it automatically only when the variable exists in that environment.

**Function timeouts on `/api/cron/discover`**
Lower `DISCOVERY_CANDIDATES_PER_RUN` (default 120). Each candidate costs at least one portfolio lookup.

**Live feed shows "Offline"**
Some corporate proxies buffer or strip SSE. The route already sets `x-accel-buffering: no`. Behind a strict proxy, fall back to polling `/api/trades?hours=1` on an interval.

---

## Operating notes

- **Costs.** Helius credits scale with whale count × sync frequency. Birdeye bills per call — `refreshTokenMarketData` is one call per token per run, so a 200-token universe refreshed every 2 h is ~2,400 calls/day.
- **Retention.** `prune_history(days)` is defined in the schema. Call it from a cron if the tables grow: `select public.prune_history(90);`
- **Scaling.** Past a few hundred whales, drop the sync cron entirely and rely on the webhook — polling every whale on a schedule is the expensive path, and the webhook does not care how many addresses it watches.
- **Monitoring.** Every job writes to `job_runs`. `/api/health` returns the last 10.
