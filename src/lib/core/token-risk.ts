/**
 * Token holder-concentration and rug-risk analysis.
 *
 * WHAT THIS IS: a measurement of how *dangerous* a token's ownership structure
 * is, built entirely from verifiable on-chain facts — who can mint more supply,
 * who can freeze your balance, and how much sellable supply sits in how few
 * hands.
 *
 * WHAT THIS IS NOT: a price prediction. Nothing here forecasts whether a token
 * will go up. Concentration tells you how badly you could be hurt if a large
 * holder decides to sell; it says nothing about whether they will. Treating a
 * risk score as a buy signal is exactly the mistake it exists to prevent.
 *
 * The single hardest part is not measuring concentration but deciding who
 * counts as a holder. The largest "holder" of almost any liquid token is an AMM
 * vault, and Raydium's V4 authority is a PDA with no account data, so it looks
 * identical to a personal wallet over RPC. Counting it as concentration makes
 * every healthy token look like a rug — see `lib/solana/entities.ts`.
 */

import { getToken } from '@/lib/db/repositories';
import * as helius from '@/lib/providers/helius';
import * as solscan from '@/lib/providers/solscan';
import {
  identifyAddress,
  isNonDiscretionaryHolder,
  type EntityKind,
} from '@/lib/solana/entities';

export interface HolderSlice {
  tokenAccount: string;
  owner: string | null;
  amount: number;
  pctOfSupply: number;
  kind: EntityKind;
  label: string;
  /** Whether this holder could choose to sell into the market. */
  discretionary: boolean;
}

export type RiskLevel = 'low' | 'moderate' | 'elevated' | 'high' | 'critical' | 'unknown';

export interface CreatorInsight {
  /** Update authority, when it is an individual rather than a platform. */
  address: string | null;
  /** Why we cannot name one, when we cannot. */
  note: string | null;
  /** Fraction of supply the creator still holds, if identifiable. */
  holdsPctOfSupply: number | null;
  /** Whether the creator appears among the largest holders at all. */
  stillHolding: boolean | null;
}

export interface TokenRisk {
  mint: string;
  symbol: string | null;
  supply: number;
  holders: HolderSlice[];
  /** Concentration among holders who can actually decide to sell. */
  top1Pct: number;
  top5Pct: number;
  top10Pct: number;
  /** Before infrastructure holders are removed, so the adjustment is auditable. */
  rawTop10Pct: number;
  excludedPct: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  canMintMore: boolean;
  canFreeze: boolean;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  /** Liquidity as a fraction of market cap — how thin the exit is. */
  liquidityRatio: number | null;
  creator: CreatorInsight;
  riskScore: number;
  riskLevel: RiskLevel;
  reasons: string[];
  checkedAt: string;
}

/** Weights sum to 100. Authority risks dominate because they are unbounded. */
const RISK_WEIGHTS = {
  mintAuthority: 30,
  freezeAuthority: 20,
  topHolder: 25,
  top10: 15,
  thinLiquidity: 10,
} as const;

function levelFor(score: number): RiskLevel {
  if (score >= 75) return 'critical';
  if (score >= 55) return 'high';
  if (score >= 35) return 'elevated';
  if (score >= 18) return 'moderate';
  return 'low';
}

/**
 * Resolves the largest token accounts to owners and classifies each one.
 *
 * `getTokenLargestAccounts` returns token *accounts*; the owner is what matters
 * for concentration, since one entity can hold across several accounts.
 */
async function resolveHolders(mint: string, supply: number): Promise<HolderSlice[]> {
  const largest = await helius.getLargestTokenAccounts(mint);
  if (!largest.length || supply <= 0) return [];

  const accounts = largest.slice(0, 20).map((entry) => entry.address);
  const owners = await helius.getTokenAccountOwners(accounts);

  const slices: HolderSlice[] = largest.slice(0, 20).map((entry, index) => {
    const owner = owners[index] ?? null;
    const identity = identifyAddress(owner ?? entry.address);
    return {
      tokenAccount: entry.address,
      owner,
      amount: entry.uiAmount,
      pctOfSupply: entry.uiAmount / supply,
      kind: identity.kind,
      label: identity.label,
      discretionary: !isNonDiscretionaryHolder(identity.kind),
    };
  });

  /*
   * Solscan tags catch exchange and market-maker wallets the curated list does
   * not know. A CEX hot wallet holds custodial balances for many users, so it
   * is not a single actor who can decide to dump. Only consulted for the top
   * few, and only when a key is configured.
   */
  if (solscan) {
    await Promise.all(
      slices.slice(0, 5).map(async (slice) => {
        if (!slice.owner || slice.kind !== 'unidentified') return;
        try {
          if (await solscan.isInstitutionalAccount(slice.owner)) {
            slice.kind = 'exchange';
            slice.label = (await solscan.getAccountLabel(slice.owner)) ?? 'Exchange / market maker';
            slice.discretionary = false;
          }
        } catch {
          // Enrichment only; leave it unidentified.
        }
      })
    );
  }

  return slices;
}

/**
 * Reads mint authority and freeze authority straight off the mint account.
 *
 * These are the two unbounded risks. A live mint authority means supply can be
 * inflated arbitrarily; a live freeze authority means an individual holder's
 * balance can be frozen. Neither is a matter of degree, which is why together
 * they carry half the weight of the score.
 */
async function readMintAuthorities(mint: string): Promise<{
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: number;
  decimals: number;
}> {
  const info = await helius.getMintInfo(mint);
  return {
    mintAuthority: info?.mintAuthority ?? null,
    freezeAuthority: info?.freezeAuthority ?? null,
    supply: info?.uiSupply ?? 0,
    decimals: info?.decimals ?? 0,
  };
}

/**
 * Identifies the token's creator, where that is meaningful.
 *
 * The update authority is the best on-chain proxy for a deployer, but for
 * launchpad tokens it is the *platform's* shared authority — pump.fun signs
 * every one of its mints with the same address. Naming that as "the developer"
 * would attribute thousands of unrelated tokens to one wallet, so known
 * platform authorities are rejected and reported as unknown instead.
 *
 * Recovering the individual deployer for a launchpad token needs either the
 * launchpad's API or the mint's creation transaction, neither of which is
 * cheaply available here.
 */
async function analyzeCreator(
  mint: string,
  holders: HolderSlice[],
  supply: number
): Promise<CreatorInsight> {
  const authority = await helius.getUpdateAuthority(mint).catch(() => null);

  if (!authority) {
    return {
      address: null,
      note: 'No update authority on this mint — the creator is not identifiable on-chain.',
      holdsPctOfSupply: null,
      stillHolding: null,
    };
  }

  const identity = identifyAddress(authority);
  if (identity.kind === 'protocol' || identity.kind === 'amm') {
    return {
      address: null,
      note: `Update authority is ${identity.label}, shared across every token from that launchpad — the individual creator is not recoverable from on-chain metadata.`,
      holdsPctOfSupply: null,
      stillHolding: null,
    };
  }

  const held = holders
    .filter((holder) => holder.owner === authority)
    .reduce((sum, holder) => sum + holder.amount, 0);

  return {
    address: authority,
    note: null,
    holdsPctOfSupply: supply > 0 ? Number((held / supply).toFixed(4)) : null,
    // Absence from the top 20 is not proof of a full exit, only that they are
    // not among the largest holders.
    stillHolding: held > 0,
  };
}

export async function analyzeTokenRisk(mint: string): Promise<TokenRisk> {
  const [authorities, token] = await Promise.all([
    readMintAuthorities(mint),
    getToken(mint).catch(() => null),
  ]);

  const holders = await resolveHolders(mint, authorities.supply);
  const creator = await analyzeCreator(mint, holders, authorities.supply);

  const discretionary = holders.filter((h) => h.discretionary);
  const excludedPct = holders
    .filter((h) => !h.discretionary)
    .reduce((sum, h) => sum + h.pctOfSupply, 0);

  const sum = (list: HolderSlice[], n: number) =>
    list.slice(0, n).reduce((total, h) => total + h.pctOfSupply, 0);

  const top1Pct = sum(discretionary, 1);
  const top5Pct = sum(discretionary, 5);
  const top10Pct = sum(discretionary, 10);
  const rawTop10Pct = sum(holders, 10);

  const liquidityUsd = token?.liquidity_usd ?? null;
  const marketCapUsd = token?.market_cap_usd ?? null;
  const liquidityRatio =
    liquidityUsd !== null && marketCapUsd && marketCapUsd > 0 ? liquidityUsd / marketCapUsd : null;

  // --- scoring -------------------------------------------------------------
  const reasons: string[] = [];
  let score = 0;

  if (authorities.mintAuthority) {
    score += RISK_WEIGHTS.mintAuthority;
    reasons.push(
      `Mint authority is still active (${authorities.mintAuthority.slice(0, 8)}…) — supply can be inflated at will.`
    );
  }
  if (authorities.freezeAuthority) {
    score += RISK_WEIGHTS.freezeAuthority;
    reasons.push(
      `Freeze authority is still active (${authorities.freezeAuthority.slice(0, 8)}…) — holder balances can be frozen.`
    );
  }

  // Largest discretionary holder: 5% → 0, 40%+ → full weight.
  const topScaled = Math.min(Math.max((top1Pct - 0.05) / 0.35, 0), 1);
  score += topScaled * RISK_WEIGHTS.topHolder;
  if (top1Pct >= 0.15) {
    reasons.push(
      `Largest non-pool holder controls ${(top1Pct * 100).toFixed(1)}% of supply${
        holders[0]?.owner ? ` (${holders.find((h) => h.discretionary)?.owner?.slice(0, 8)}…)` : ''
      }.`
    );
  }

  // Top 10 combined: 25% → 0, 80%+ → full weight.
  const top10Scaled = Math.min(Math.max((top10Pct - 0.25) / 0.55, 0), 1);
  score += top10Scaled * RISK_WEIGHTS.top10;
  if (top10Pct >= 0.5) {
    reasons.push(
      `Top 10 non-pool holders control ${(top10Pct * 100).toFixed(1)}% of supply between them.`
    );
  }

  // Thin liquidity: below 2% of market cap is a hard exit.
  if (liquidityRatio !== null) {
    const thin = Math.min(Math.max((0.02 - liquidityRatio) / 0.02, 0), 1);
    score += thin * RISK_WEIGHTS.thinLiquidity;
    if (liquidityRatio < 0.02) {
      reasons.push(
        `Liquidity is only ${(liquidityRatio * 100).toFixed(2)}% of market cap — a large sell would move price sharply.`
      );
    }
  }

  // Creator position is a dump vector in its own right.
  if (creator.address && creator.holdsPctOfSupply !== null) {
    if (creator.holdsPctOfSupply >= 0.05) {
      score += Math.min(creator.holdsPctOfSupply / 0.3, 1) * 10;
      reasons.push(
        `Creator wallet (${creator.address.slice(0, 8)}…) still holds ${(creator.holdsPctOfSupply * 100).toFixed(1)}% of supply.`
      );
    } else if (!creator.stillHolding) {
      reasons.push(
        `Creator wallet (${creator.address.slice(0, 8)}…) is not among the largest holders — it may have already sold down.`
      );
    }
  }

  const unidentified = discretionary.filter((h) => h.kind === 'unidentified').length;
  if (unidentified > 0 && top10Pct >= 0.3) {
    reasons.push(
      `${unidentified} of the largest holders could not be identified; they are counted as discretionary, which may overstate risk if any are pools or exchanges.`
    );
  }

  if (!reasons.length) {
    reasons.push('No mint or freeze authority, and supply is not concentrated in few sellable hands.');
  }

  const riskScore = Number(Math.min(score, 100).toFixed(2));

  return {
    mint,
    symbol: token?.symbol ?? null,
    supply: authorities.supply,
    holders,
    top1Pct: Number(top1Pct.toFixed(4)),
    top5Pct: Number(top5Pct.toFixed(4)),
    top10Pct: Number(top10Pct.toFixed(4)),
    rawTop10Pct: Number(rawTop10Pct.toFixed(4)),
    excludedPct: Number(excludedPct.toFixed(4)),
    mintAuthority: authorities.mintAuthority,
    freezeAuthority: authorities.freezeAuthority,
    canMintMore: Boolean(authorities.mintAuthority),
    canFreeze: Boolean(authorities.freezeAuthority),
    liquidityUsd,
    marketCapUsd,
    liquidityRatio: liquidityRatio === null ? null : Number(liquidityRatio.toFixed(6)),
    creator,
    riskScore,
    riskLevel: authorities.supply > 0 ? levelFor(riskScore) : 'unknown',
    reasons,
    checkedAt: new Date().toISOString(),
  };
}
