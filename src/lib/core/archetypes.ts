/**
 * Wallet archetypes — what kind of trader this wallet behaves like.
 *
 * Every tag is a description of measured behaviour, never a claim about who
 * someone is. "Bot" means machine-speed transaction rates, not that a person is
 * running software commercially. "Smart money" means a measured edge over the
 * cycles we observed, not that the wallet will keep winning.
 *
 * Three rules keep this from becoming astrology:
 *
 *   1. Every tag carries its own evidence. A badge you cannot interrogate is
 *      decoration, so each one states the numbers that produced it.
 *   2. Thin evidence produces `provisional`, and skill tags are withheld
 *      entirely below a sample floor. Five closed trades is not a track record,
 *      and calling such a wallet "smart money" would be worse than saying
 *      nothing — it invites someone to copy a coin flip.
 *   3. Tags are not exclusive. A wallet is routinely a sniper *and* a flipper
 *      *and* underwater; forcing one label per wallet throws away most of what
 *      was measured.
 *
 * Pure: no I/O, no imports. The caller gathers metrics, this decides. That
 * keeps the thresholds testable without a database.
 */

export type ArchetypeKind = 'activity' | 'style' | 'skill' | 'risk' | 'position';

export interface Archetype {
  tag: string;
  label: string;
  kind: ArchetypeKind;
  /** The measurement behind the tag, in plain language. */
  detail: string;
  /** `observed` when the sample supports it; `provisional` when it is thin. */
  confidence: 'observed' | 'provisional';
}

export interface ArchetypeMetrics {
  address: string;
  portfolioValueUsd: number;
  tradeCount30d: number;
  distinctTokens30d: number;
  avgTradeSizeUsd: number;

  /** Completed entry→exit cycles with a known cost basis. */
  closedCycles: number;
  medianHoldHours: number | null;
  winRate: number | null;
  profitFactor: number | null;
  realizedPnlUsd: number;
  /** Spread of per-cycle returns. High means feast or famine. */
  pnlPctStdev: number | null;

  netFlow30dUsd: number;
  openPositions: number;
  /** Largest single position as a share of the book. */
  maxConvictionPct: number | null;
  /** Share of open positions sitting at a material loss. */
  underwaterShare: number | null;

  /** Transactions per hour, from the funding-graph walk. Null if never walked. */
  txPerHour: number | null;
  /** Launch snipes recorded for this wallet. */
  snipeCount: number;
  daysTracked: number;
}

// --- thresholds, each with a reason ----------------------------------------

/** No human signs transactions at this rate. */
const BOT_TX_PER_HOUR = 100;
/** Sustained flow that a person could not place by hand either. */
const BOT_TRADES_30D = 400;

/** Below this, skill statistics are noise and are withheld entirely. */
const MIN_CYCLES_FOR_SKILL = 8;
/** Enough cycles to call a pattern observed rather than provisional. */
const CONFIDENT_CYCLES = 15;

const FLIPPER_HOURS = 6;
const HOLDER_HOURS = 24 * 7;

/** Dollars won per dollar lost. 1.0 is breakeven. */
const SMART_PROFIT_FACTOR = 1.5;
const SMART_WIN_RATE = 0.45;

/** Feast-or-famine: outcomes swing by more than 100% around the mean. */
const GAMBLER_STDEV = 1.0;
const GAMBLER_WIN_RATE = 0.4;

const CONCENTRATED_PCT = 0.25;
const DIVERSIFIED_MAX_PCT = 0.1;
const DIVERSIFIED_TOKENS = 10;

const UNDERWATER_SHARE = 0.5;

/** Large book, few trades — size that is not being churned. */
const SIZE_PLAYER_USD = 1_000_000;
const SIZE_PLAYER_MAX_TRADES = 25;

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function hours(value: number): string {
  if (value < 1) return `${Math.round(value * 60)}m`;
  if (value < 48) return `${value.toFixed(1)}h`;
  return `${(value / 24).toFixed(1)}d`;
}

function usd(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/**
 * Classifies a wallet from its measured behaviour.
 *
 * Returns every tag that fits, ordered so the most decision-relevant comes
 * first: skill, then risk, then how it trades, then what it is holding.
 */
export function classifyWallet(m: ArchetypeMetrics): Archetype[] {
  const tags: Archetype[] = [];
  const skillSample = m.closedCycles >= MIN_CYCLES_FOR_SKILL;
  const confident = m.closedCycles >= CONFIDENT_CYCLES ? 'observed' : 'provisional';

  // --- skill -------------------------------------------------------------
  // Withheld entirely below the sample floor rather than reported weakly. A
  // "smart money" badge on five lucky closes invites someone to copy noise.
  if (skillSample && m.profitFactor !== null && m.winRate !== null) {
    if (m.profitFactor >= SMART_PROFIT_FACTOR && m.winRate >= SMART_WIN_RATE) {
      tags.push({
        tag: 'smart_money',
        label: 'Smart money',
        kind: 'skill',
        detail: `Made ${m.profitFactor.toFixed(2)}x as much on winners as it lost on losers, winning ${pct(m.winRate)} of ${m.closedCycles} closed positions.`,
        confidence: confident,
      });
    } else if (m.profitFactor < 0.8) {
      tags.push({
        tag: 'losing',
        label: 'Losing money',
        kind: 'skill',
        detail: `Lost more than it won across ${m.closedCycles} closed positions (profit factor ${m.profitFactor.toFixed(2)}, ${usd(m.realizedPnlUsd)} realised).`,
        confidence: confident,
      });
    }
  }

  // --- risk --------------------------------------------------------------
  if (
    m.closedCycles >= 5 &&
    m.pnlPctStdev !== null &&
    m.pnlPctStdev >= GAMBLER_STDEV &&
    m.winRate !== null &&
    m.winRate < GAMBLER_WIN_RATE
  ) {
    tags.push({
      tag: 'gambler',
      label: 'Gambler',
      kind: 'risk',
      detail: `Outcomes swing wildly — returns vary by ±${pct(m.pnlPctStdev)} around the mean while only ${pct(m.winRate)} of positions close green. Occasional large wins carry the record.`,
      confidence: m.closedCycles >= CONFIDENT_CYCLES ? 'observed' : 'provisional',
    });
  }

  if (m.maxConvictionPct !== null && m.maxConvictionPct >= CONCENTRATED_PCT) {
    tags.push({
      tag: 'concentrated',
      label: 'Concentrated',
      kind: 'risk',
      detail: `Largest single position is ${pct(m.maxConvictionPct)} of the book. One token decides this wallet's outcome.`,
      confidence: 'observed',
    });
  } else if (
    m.distinctTokens30d >= DIVERSIFIED_TOKENS &&
    m.maxConvictionPct !== null &&
    m.maxConvictionPct < DIVERSIFIED_MAX_PCT
  ) {
    tags.push({
      tag: 'diversified',
      label: 'Diversified',
      kind: 'risk',
      detail: `Spread across ${m.distinctTokens30d} tokens in 30 days with no position above ${pct(m.maxConvictionPct)} of the book.`,
      confidence: 'observed',
    });
  }

  if (m.underwaterShare !== null && m.openPositions >= 3 && m.underwaterShare >= UNDERWATER_SHARE) {
    tags.push({
      tag: 'bagholder',
      label: 'Holding losses',
      kind: 'risk',
      detail: `${pct(m.underwaterShare)} of open positions are down more than 30% from entry. Losers are being held rather than cut.`,
      confidence: 'observed',
    });
  }

  // --- activity ----------------------------------------------------------
  // Velocity is the one signal here that is close to conclusive: no person
  // signs a hundred transactions an hour by hand.
  if (m.txPerHour !== null && m.txPerHour >= BOT_TX_PER_HOUR) {
    tags.push({
      tag: 'bot',
      label: 'Automated',
      kind: 'activity',
      detail: `Sustained ${m.txPerHour.toFixed(0)} transactions per hour. That is machine speed, not manual trading.`,
      confidence: 'observed',
    });
  } else if (m.tradeCount30d >= BOT_TRADES_30D) {
    tags.push({
      tag: 'bot',
      label: 'Automated',
      kind: 'activity',
      detail: `${m.tradeCount30d} trades in 30 days — a rate that implies automation.`,
      confidence: 'provisional',
    });
  }

  if (m.snipeCount >= 3) {
    tags.push({
      tag: 'sniper',
      label: 'Launch sniper',
      kind: 'activity',
      detail: `Bought within minutes of launch on ${m.snipeCount} tokens. Common for bots, and the same pattern a wallet with advance notice would leave.`,
      confidence: m.snipeCount >= 8 ? 'observed' : 'provisional',
    });
  }

  // --- style -------------------------------------------------------------
  if (m.medianHoldHours !== null && m.closedCycles >= 3) {
    if (m.medianHoldHours < FLIPPER_HOURS) {
      tags.push({
        tag: 'flipper',
        label: 'Flipper',
        kind: 'style',
        detail: `Typically in and out within ${hours(m.medianHoldHours)}. Trades momentum, not theses.`,
        confidence: m.closedCycles >= CONFIDENT_CYCLES ? 'observed' : 'provisional',
      });
    } else if (m.medianHoldHours > HOLDER_HOURS) {
      tags.push({
        tag: 'holder',
        label: 'Long holder',
        kind: 'style',
        detail: `Typically holds ${hours(m.medianHoldHours)} before exiting.`,
        confidence: m.closedCycles >= CONFIDENT_CYCLES ? 'observed' : 'provisional',
      });
    } else {
      tags.push({
        tag: 'swing',
        label: 'Swing trader',
        kind: 'style',
        detail: `Typically holds ${hours(m.medianHoldHours)} — days, not minutes or months.`,
        confidence: m.closedCycles >= CONFIDENT_CYCLES ? 'observed' : 'provisional',
      });
    }
  }

  if (
    m.portfolioValueUsd >= SIZE_PLAYER_USD &&
    m.tradeCount30d > 0 &&
    m.tradeCount30d <= SIZE_PLAYER_MAX_TRADES
  ) {
    tags.push({
      tag: 'size_player',
      label: 'Size, low turnover',
      kind: 'style',
      detail: `${usd(m.portfolioValueUsd)} book but only ${m.tradeCount30d} trades in 30 days, averaging ${usd(m.avgTradeSizeUsd)}. Deploys size and sits.`,
      confidence: 'observed',
    });
  }

  // --- position ----------------------------------------------------------
  if (m.tradeCount30d >= 5) {
    if (m.netFlow30dUsd > 0) {
      tags.push({
        tag: 'accumulating',
        label: 'Accumulating',
        kind: 'position',
        detail: `Net ${usd(m.netFlow30dUsd)} bought over the last 30 days.`,
        confidence: 'observed',
      });
    } else if (m.netFlow30dUsd < 0) {
      tags.push({
        tag: 'distributing',
        label: 'Distributing',
        kind: 'position',
        detail: `Net ${usd(Math.abs(m.netFlow30dUsd))} sold over the last 30 days.`,
        confidence: 'observed',
      });
    }
  }

  // --- nothing measurable -------------------------------------------------
  if (!tags.length) {
    tags.push({
      tag: 'unclassified',
      label: 'Not enough history',
      kind: 'activity',
      detail:
        m.daysTracked < 7
          ? `Tracked for ${m.daysTracked.toFixed(0)} days with ${m.closedCycles} closed positions — too little to characterise.`
          : `${m.closedCycles} closed positions recorded. Not enough completed activity to characterise this wallet.`,
      confidence: 'provisional',
    });
  }

  const order: ArchetypeKind[] = ['skill', 'risk', 'activity', 'style', 'position'];
  return tags.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

/** The single tag worth showing when there is only room for one. */
export function primaryArchetype(tags: Archetype[]): Archetype | null {
  return tags[0] ?? null;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
