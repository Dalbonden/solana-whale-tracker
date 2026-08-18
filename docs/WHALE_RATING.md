# Whale Rating — a track-record grade computed from what we observed

Supersedes the `smart_score` sketch in [TRADER_ROADMAP.md](./TRADER_ROADMAP.md) §3.

The goal is a letter grade — `A+` … `F`, or an honest `Unrated` — that answers
one question: **has this wallet actually been good, or did it just have size?**

The current `whales.score` measures size, activity and meme exposure. It says
nothing about skill. A wallet with $40M that loses on every trade scores
`kraken` today.

---

## 1. Four ways a naive rating is wrong

Every one of these is a real bias that shows up immediately if ignored.

### 1.1 Realised-only P&L overstates skill — systematically

Traders sell winners early and hold losers (the disposition effect, Shefrin &
Statman 1985 — it replicates everywhere, including on-chain). If the rating
counts only closed positions, a wallet that has taken twelve small gains while
sitting on four −85% bags reads as a *twelve-win streak*.

**Fix:** rate on **mark-to-market total return** — realised proceeds *plus*
current value of open positions, against total cost. Open bags count against
you, exactly as they do in reality.

### 1.2 In a bull market everyone is a genius

A whale up 40% over a month when the meme complex was up 200% did not
outperform; they underperformed badly. Raw return measures *when they were
alive*, not *how good they are*.

**Fix:** rate on **alpha** — return minus what a meme index did over the same
holding window. This is the single biggest upgrade over any competitor, and it
is the thing that will occasionally rate a famous wallet a `C`.

### 1.3 Meme returns are too skewed for a mean

One 40x drags the average positive no matter how many −90%s sit behind it.
Mean return will rate a lottery-ticket wallet highly forever.

**Fix:** use **median alpha** and a **profit factor on alpha** as the central
statistics, never the mean. Report dispersion separately as a risk read.

### 1.4 Small samples masquerade as skill

Three good closes is not a track record; it is three coin flips.

**Fix:** confidence is a **multiplier**, and below a floor the wallet is
published as `Unrated (7/12 cycles observed)` rather than given a soft grade.
Refusing to rate is itself information, and users trust it more than a hedged
number.

---

## 2. The unit of measurement: a position cycle

Not a trade. A **cycle** is entry → full exit (or → still open), built on the
`whale_positions` table from the roadmap.

```
cost_usd      = total_bought_usd
proceeds_usd  = total_sold_usd
mark_usd      = amount * current_price          -- 0 for closed cycles
return_pct    = (proceeds_usd + mark_usd - cost_usd) / cost_usd
holding_hours = coalesce(closed_at, now()) - opened_at
```

Cycles with `basis_complete = false` are **excluded from the rating entirely**
and counted toward `basis_coverage_pct`. We do not guess an entry we never saw.

---

## 3. The benchmark

Alpha needs something to be alpha against. Build an equal-weight index over the
core meme basket (`meme_tokens.is_core`), which is already price-refreshed
hourly by `/api/cron/tokens`.

```sql
create table if not exists public.market_index_history (
  ts          timestamptz primary key,
  index_value numeric(24,8) not null,   -- rebased to 100 at inception
  members     integer not null,
  method      text not null default 'equal_weight_core'
);
```

Equal-weight, not market-cap-weight: a cap-weighted meme index is just BONK,
and comparing a small-cap trader to BONK measures nothing.

```
index_return(t0, t1) = index_value(t1) / index_value(t0) - 1
alpha_pct            = return_pct - index_return(opened_at, closed_at ?? now())
```

**Bootstrapping:** we have no index history yet. Backfill hourly OHLCV for the
~10 core mints from Birdeye — that is ~10 requests per candle page, a one-off
job, well inside free-tier budget. Until it exists, `alpha_pct` is `null` and
the rating stays `Unrated`. That is the correct behaviour, not a blocker to
route around.

---

## 4. The formula

```ts
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const norm = (x: number, lo: number, hi: number) => clamp01((x - lo) / (hi - lo));

// Recency: a genius from three cycles ago is not a genius today.
const HALF_LIFE_DAYS = 60;
const w = (cycle) => Math.pow(0.5, ageDays(cycle) / HALF_LIFE_DAYS);

// --- 1. Alpha (40%) — weighted median, not mean. Skew-proof.
const medAlpha   = weightedMedian(cycles.map(c => c.alpha_pct), cycles.map(w));
const alphaScore = norm(medAlpha, -0.25, 0.75);        // -25% -> 0, +75% -> 1

// --- 2. Consistency (25%) — hit rate on ALPHA, not on P&L.
//     Beating the market 55% of the time is a real edge.
const hitRate    = weightedShare(cycles, c => c.alpha_pct > 0, w);
const consistency = norm(hitRate, 0.35, 0.65);

// --- 3. Edge quality (20%) — profit factor computed on alpha.
const gross = { win: Σ w·alpha where alpha>0, loss: |Σ w·alpha where alpha<0| };
const profitFactor = gross.loss > 0 ? gross.win / gross.loss : (gross.win > 0 ? 3 : 0);
const edgeScore    = norm(profitFactor, 0.8, 3.0);

// --- 4. Sizing skill (15%) — do they bet BIG on their GOOD ideas?
//     Rank correlation, because two outliers would own a Pearson r.
const rho        = spearman(cycles.map(c => c.conviction_pct),
                            cycles.map(c => c.alpha_pct));
const sizingScore = norm(rho, -0.2, 0.6);

// --- Confidence MULTIPLIES. Thin evidence cannot produce a high grade.
const sampleConf   = norm(effectiveN, 6, 30);          // Σw, not raw count
const coverageConf = norm(basisCoveragePct, 0.30, 0.80);
const confidence   = sampleConf * (0.5 + 0.5 * coverageConf);

const raw    = 0.40*alphaScore + 0.25*consistency + 0.20*edgeScore + 0.15*sizingScore;
const rating = 100 * confidence * raw;
```

**Sizing skill is the component that is hardest to fake.** Anyone can hold a
token that went up. Consistently putting 18% of the book into the ones that
worked and 2% into the ones that did not is skill, and it is measurable because
`whale_portfolios.pct_of_portfolio` is already recorded.

### Grades

| Grade | Rating | Reading |
|---|---|---|
| `A+` | ≥ 85 | Beats the meme index consistently, sizes well, deep sample |
| `A` | 75–85 | Clear edge |
| `B` | 60–75 | Beats the index more often than not |
| `C` | 45–60 | Roughly index-equivalent — size, not skill |
| `D` | 30–45 | Underperforms holding the basket |
| `F` | < 30 | Actively destroys capital |
| `Unrated` | — | `effectiveN < 6` or `basis_coverage < 30%` |

A `C` is the honest modal grade, and most tracked whales will land there. If
the distribution comes out mostly `A`, the rating is broken — say so rather
than shipping it.

---

## 5. Show the report card, not just the letter

A bare grade is unfalsifiable. Render it decomposed, like a credit report:

```
┌──────────────────────────────────────────────────────┐
│  9xQe…3f2A                                    ┌────┐ │
│  Rating                                       │ B+ │ │
│                                               └────┘ │
│  Alpha (median)      +34%   vs index  ████████░░  72 │
│  Consistency          58%   hit rate  ██████░░░░  61 │
│  Edge quality        1.9x   profit f. █████░░░░░  52 │
│  Sizing skill        0.41   rank corr ███████░░░  68 │
│  ─────────────────────────────────────────────────── │
│  22 cycles observed · 71% basis coverage             │
│  Best: WIF +412% alpha · Worst: MEW −88% alpha       │
│  Median hold 3.2 days · rated since 12 Mar           │
└──────────────────────────────────────────────────────┘
```

Every number links to the cycles behind it. A trader who can audit the grade
will trust it; one who cannot will assume it is marketing.

---

## 6. Shadow portfolio — the version people actually feel

The rating is abstract. This is not:

> **If you had mirrored this wallet's last 20 entries at 1% of your book each
> and exited when they did, you would be at +38%. The meme index did +12% over
> the same period.**

Fully computable from `whale_positions` and `market_index_history`. No new data
required. Assumptions must be stated on the panel — fills at the whale's
observed price, no slippage, no fees — and it should be labelled a
reconstruction, not a backtest of a strategy you could have run live.

This is the single most persuasive artefact the product can show, and it is a
day of work once positions exist.

---

## 7. Schema

```sql
create table if not exists public.whale_ratings (
  whale_address      text not null references public.whales(address) on delete cascade,
  computed_at        timestamptz not null default now(),

  rating             numeric(6,2),            -- null when unrated
  grade              text not null check (grade in
                       ('A+','A','B','C','D','F','Unrated')),

  alpha_score        numeric(6,2),
  consistency_score  numeric(6,2),
  edge_score         numeric(6,2),
  sizing_score       numeric(6,2),

  median_alpha_pct   numeric(10,4),
  alpha_hit_rate     numeric(6,4),
  profit_factor      numeric(10,4),
  sizing_rho         numeric(6,4),

  cycles_n           integer not null default 0,
  effective_n        numeric(10,4) not null default 0,   -- recency-weighted
  basis_coverage_pct numeric(6,4) not null default 0,
  confidence         numeric(6,4) not null default 0,

  best_cycle_mint    text,
  worst_cycle_mint   text,
  median_hold_hours  numeric(12,2),

  primary key (whale_address, computed_at)
);

create index on public.whale_ratings (whale_address, computed_at desc);
create index on public.whale_ratings (computed_at desc, rating desc nulls last);
```

Ratings are **append-only history**, never overwritten. That is what makes §9
possible — you cannot forward-test a rating you have overwritten.

Denormalise the newest `grade` and `rating` onto `whales` for cheap list
queries.

---

## 8. Getting enough history: backfill, do not wait

At ~10 whales with only recent tracking, nearly every wallet is `Unrated`
today, and waiting for organic history means waiting months.

Backfill instead. `getSignaturesForAddress` paginates back through a wallet's
full history; the existing `parse.ts` swap decoder already turns those into
trades with no changes. A one-off `/api/cron/backfill` job walking ~1000
signatures per whale, oldest-first, produces months of cycles immediately.

Costs and caveats, honestly:

- ~10–20 Helius enhanced-transaction calls per whale at 100 tx/page. Trivial at
  10 whales, a real budget line at 300 — run it once per whale at discovery
  time, never repeatedly.
- Historical **pricing** is the hard part. `usd_value` at ingest uses the
  current price; for backfilled trades we need the price *at block time*.
  Birdeye OHLCV `/defi/history_price` gives per-minute candles — one call per
  (mint, day) is enough, cached hard, and it is the only correct way to do
  this. Without it every backfilled cycle is mispriced and the rating is
  garbage.
- Tokens that have since died may have no price history at all. Mark those
  cycles `basis_complete = false` and let them lower coverage rather than
  inventing a number.

---

## 9. Validating the rating — the part that makes it real

A rating nobody has tested is decoration. Test it the only way that means
anything: **out of sample, forward.**

```
1. Freeze all ratings at time T (they are append-only, so this is a query).
2. Measure each whale's actual alpha over [T, T+30d].
3. Compute Spearman rank correlation between rating at T and forward alpha.
4. Publish that number. Re-run monthly.
```

Interpretation:

- `rho > 0.3` — the rating has real predictive power. Say so, with the number.
- `rho ≈ 0` — it describes the past and predicts nothing. Say that too, and
  reweight.
- `rho < 0` — high-rated whales are mean-reverting; the rating is a contrarian
  indicator, which is itself a finding worth shipping.

Also report the practical version: **average forward alpha of `A`-rated whales
versus `C`-rated whales.** If they are the same, the grades are cosmetic.

Publish results in `docs/TRACK_RECORD.md` including bad ones. A rating with a
published, mediocre validation score is worth more than an unvalidated rating
that claims everything, because a trader can size their trust accordingly.

---

## 10. Known limitations — state these in the UI

1. **One wallet ≠ one trader.** Whales split across many addresses. A rating is
   for an address, and a wallet that looks like a `D` may be one leg of a
   hedged book. Funding-graph clustering is the fix and it is a large project.
2. **We only see swaps we parse.** OTC, CEX legs, bridged exits and LP
   positions are invisible. A whale who exits via a CEX looks like a
   bagholder forever.
3. **The index is a choice.** Equal-weight core memes is defensible but
   arbitrary; a different basket produces different alpha. Publish the
   constituents.
4. **Survivorship in discovery.** We find whales via Birdeye top traders and
   large holders — both filters that select for recent winners. The rated
   population is not a random sample of wallets, and average ratings will look
   better than the population truth.
5. **Ratings move.** A `B` can become a `D` on one bad cycle when the sample is
   thin. Show the trend line, not just today's letter.

---

## 11. Build order

| Step | Depends on | Effort |
|---|---|---|
| 1. `whale_positions` + backfill replay | roadmap §2 | 1 day |
| 2. `market_index_history` + core-basket OHLCV backfill | Birdeye | half day |
| 3. Historical pricing for backfilled trades | Birdeye `history_price` | 1 day, the fiddly one |
| 4. Cycle outcomes view (`return_pct`, `alpha_pct`, `conviction_pct`) | 1–3 | half day |
| 5. Rating computation + `whale_ratings` + hourly cron | 4 | 1 day |
| 6. Report-card UI + grade column on `/whales` | 5 | 1 day |
| 7. Shadow portfolio panel | 4 | half day |
| 8. Forward validation job + `TRACK_RECORD.md` | 5 + 30 days elapsed | half day, then wait |

Step 3 is where this succeeds or fails. Everything downstream is arithmetic on
top of correctly-priced history; get the pricing wrong and the grades are
confident nonsense.
