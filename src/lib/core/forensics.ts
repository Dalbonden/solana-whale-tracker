/**
 * Launch forensics — behavioural analysis of who bought a token first.
 *
 * WHAT THIS IS
 *
 * A description of publicly visible on-chain behaviour: who bought in the first
 * seconds, how much of the opening supply they took, whether they still hold
 * it, and which wallets moved in lockstep. Every input is a public transaction.
 *
 * WHAT THIS IS NOT
 *
 * Not an accusation, and deliberately not capable of making one. Nothing here
 * establishes identity, intent, coordination, or that anything improper
 * occurred. Fast buying is not wrongdoing: bots snipe every launch
 * indiscriminately, market makers are funded by the team by arrangement, and a
 * wallet buying in second one may simply have been watching the mempool.
 *
 * So the output is a *suspicion* score in the sense of "worth a closer look",
 * and the copy never says more than the data supports. Concretely:
 *
 *   - patterns are stated as observations, never as conclusions about a person
 *   - a wallet we cannot identify is reported as unidentified, never guessed at
 *   - infrastructure (pools, burns, launchpad programs) is excluded rather than
 *     scored, because counting a Raydium vault as an "insider" is nonsense
 *   - confidence is reported alongside every finding, including when it is low
 *
 * The honest framing is a feature. A tool that labels every fast wallet a
 * criminal is not just unfair, it is useless — the signal disappears into false
 * positives.
 */

import * as birdeye from '@/lib/providers/birdeye';
import * as helius from '@/lib/providers/helius';
import { identifyAddress, isNonDiscretionaryHolder } from '@/lib/solana/entities';
import { NATIVE_SOL } from '@/lib/solana/constants';

import {
  buildFundingGraph,
  findMintCreator,
  MAX_TRACED_CANDIDATES,
  type DeployerLink,
  type SharedFunderGroup,
} from './funding-graph';
import { newCounter } from './trace-store';

/** Buys inside this window of the first trade are treated as launch snipes. */
const SNIPE_WINDOW_SECONDS = 60;
/** Buys this close together are treated as one synchronised cohort. */
const CLUSTER_WINDOW_SECONDS = 3;
/** How many opening trades to reconstruct. */
const EARLY_TRADE_SAMPLE = 200;

export type SuspicionLevel = 'low' | 'medium' | 'high';

export interface ForensicSignal {
  /** Stable key, so the UI can style without string matching. */
  code: string;
  /** What was observed — phrased as behaviour, never as intent. */
  detail: string;
  weight: number;
}

export interface SuspectWallet {
  address: string;
  /** Seconds between the token's first trade and this wallet's first buy. */
  secondsAfterLaunch: number;
  firstBuyAt: string;
  tokensBought: number;
  usdBought: number | null;
  /** Share of all tokens bought across the sampled opening trades. */
  shareOfEarlyVolume: number;
  buyCount: number;
  sellCount: number;
  /** Still among the largest holders. Null when the holder list is unavailable. */
  stillHolding: boolean | null;
  /** Current share of supply, when they appear in the holder list. */
  pctOfSupply: number | null;
  /** Exchanged value directly with the deployer wallet. */
  linkedToDeployer: boolean;
  /** How the wallet connects to the deployer, when it does. */
  deployerLink: DeployerLink | null;
  /** Wallets this one shares a funding source with. */
  sharedFunderWith: string[];
  /** Whether the funding walk reached this wallet's own history. */
  fundingTraced: boolean;
  /** Id of the synchronised-buy cohort this wallet belongs to, if any. */
  clusterId: number | null;
  score: number;
  level: SuspicionLevel;
  signals: ForensicSignal[];
}

export interface BuyCluster {
  id: number;
  /** Wallets whose first buy landed inside the same few seconds. */
  members: string[];
  atSecondsAfterLaunch: number;
  combinedTokens: number;
  combinedShareOfEarlyVolume: number;
  membersLinkedToDeployer: number;
}

export interface ForensicsReport {
  mint: string;
  symbol: string | null;
  /** First trade we can find. Null when the token has no trade feed. */
  launchAt: string | null;
  deployer: {
    address: string | null;
    /** Which source identified it, so the reader can weigh the claim. */
    via: 'update_authority' | 'mint_creation' | null;
    note: string | null;
    /** Deployer appears among the largest holders. */
    stillHolding: boolean | null;
    pctOfSupply: number | null;
    /** Counterparties found while scanning the deployer's transactions. */
    counterpartiesScanned: number;
  };
  mintAuthorityActive: boolean;
  freezeAuthorityActive: boolean;
  earlyTradesSampled: number;
  distinctEarlyBuyers: number;
  /**
   * How ordinary fast buying was at this particular launch. When most of the
   * book snipes, speed stops being evidence of anything.
   */
  launchProfile: {
    sniperCount: number;
    sniperRatio: number;
    /** Factor the snipe signal was scaled by, given the ratio above. */
    speedDiscount: number;
    botSwarm: boolean;
  };
  suspects: SuspectWallet[];
  clusters: BuyCluster[];
  /** Funding sources shared by two or more of the traced wallets. */
  sharedFunders: SharedFunderGroup[];
  funding: {
    candidatesTraced: number;
    candidatesReachedGenesis: number;
    tracesFailed: number;
    deployerOutboundWallets: number;
    hopWalletsExpanded: number;
    requests: number;
    cacheHits: number;
    cacheMisses: number;
    cacheAvailable: boolean;
  };
  summary: string[];
  /** What could not be determined, stated plainly rather than left implied. */
  limitations: string[];
  error?: string;
}

function levelFor(score: number): SuspicionLevel {
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

export async function analyseLaunch(mint: string): Promise<ForensicsReport> {
  const limitations: string[] = [];
  // One counter for the whole analysis, so mint-creator lookup, deployer scan
  // and candidate walks share a single cache session and request tally.
  const walkCounter = newCounter();

  const [trades, holders, mintInfo, updateAuthority] = await Promise.all([
    birdeye.getEarliestTrades(mint, EARLY_TRADE_SAMPLE).catch(() => []),
    birdeye.getTokenHolders(mint, 50).catch(() => []),
    helius.getMintInfo(mint).catch(() => null),
    helius.getUpdateAuthority(mint).catch(() => null),
  ]);

  const report: ForensicsReport = {
    mint,
    symbol: null,
    launchAt: null,
    deployer: {
      address: null,
      via: null,
      note: null,
      stillHolding: null,
      pctOfSupply: null,
      counterpartiesScanned: 0,
    },
    mintAuthorityActive: Boolean(mintInfo?.mintAuthority),
    freezeAuthorityActive: Boolean(mintInfo?.freezeAuthority),
    earlyTradesSampled: trades.length,
    distinctEarlyBuyers: 0,
    launchProfile: { sniperCount: 0, sniperRatio: 0, speedDiscount: 1, botSwarm: false },
    suspects: [],
    clusters: [],
    sharedFunders: [],
    funding: {
      candidatesTraced: 0,
      candidatesReachedGenesis: 0,
      tracesFailed: 0,
      deployerOutboundWallets: 0,
      hopWalletsExpanded: 0,
      requests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheAvailable: true,
    },
    summary: [],
    limitations,
  };

  if (!trades.length) {
    report.error =
      'No trade history available for this mint. It may not be a tradable SPL token, or no indexed market covers it.';
    return report;
  }

  // --- deployer ------------------------------------------------------------
  // An update authority shared across a launchpad's whole catalogue is the
  // platform, not the person who made this token. Naming it as the creator
  // would tag one address as the deployer of thousands of unrelated tokens.
  const authorityEntity = updateAuthority ? identifyAddress(updateAuthority) : null;
  let deployer =
    updateAuthority && authorityEntity && authorityEntity.kind === 'unidentified'
      ? updateAuthority
      : null;
  let deployerVia: 'update_authority' | 'mint_creation' | null = deployer
    ? 'update_authority'
    : null;

  // Metadata is a dead end on launchpad tokens, which are most of what anyone
  // wants analysed. Fall back to whoever paid to create the mint.
  if (!deployer) {
    const creator = await findMintCreator(mint, walkCounter).catch(() => ({
      address: null,
      via: null as null,
    }));
    if (creator.address) {
      deployer = creator.address;
      deployerVia = 'mint_creation';
    }
  }

  report.deployer.via = deployerVia;

  if (!deployer) {
    report.deployer.note = updateAuthority
      ? `Update authority is ${authorityEntity?.label ?? 'a known program'}, which is shared across every token from that platform, and the mint's creation transaction was not reachable within the page budget — so the individual deployer could not be identified.`
      : 'No update authority is set and the mint creation transaction was not reachable, so the deployer could not be identified.';
    limitations.push('Deployer wallet could not be identified, so deployer links were not checked.');
  } else if (deployerVia === 'mint_creation') {
    limitations.push(
      'The deployer was identified as the wallet that paid to create the mint. That is who funded the creation, which is usually but not always the same person as the operator.'
    );
  }

  const launchUnix = trades[0].blockUnixTime;
  report.launchAt = new Date(launchUnix * 1000).toISOString();

  // --- holders -------------------------------------------------------------
  const totalHeld = holders.reduce((sum, h) => sum + h.uiAmount, 0);
  const holderShare = new Map<string, number>();
  for (const holder of holders) {
    if (totalHeld > 0) holderShare.set(holder.owner, holder.uiAmount / totalHeld);
  }
  if (!holders.length) {
    limitations.push('Holder list unavailable, so "still holding" could not be determined.');
  }

  if (deployer) {
    report.deployer.address = deployer;
    report.deployer.stillHolding = holders.length ? holderShare.has(deployer) : null;
    report.deployer.pctOfSupply = holderShare.get(deployer) ?? null;
  }

  // --- aggregate the opening trades per wallet -----------------------------
  interface Acc {
    firstBuyUnix: number;
    tokensBought: number;
    usdBought: number;
    usdKnown: boolean;
    buys: number;
    sells: number;
  }
  const byWallet = new Map<string, Acc>();

  for (const trade of trades) {
    const entity = identifyAddress(trade.owner);
    // Pools and programs transact on every trade; they are not participants.
    if (isNonDiscretionaryHolder(entity.kind)) continue;

    const acc = byWallet.get(trade.owner) ?? {
      firstBuyUnix: Infinity,
      tokensBought: 0,
      usdBought: 0,
      usdKnown: false,
      buys: 0,
      sells: 0,
    };

    if (trade.side === 'buy') {
      acc.buys += 1;
      acc.tokensBought += trade.tokenAmount;
      if (trade.usdValue !== null) {
        acc.usdBought += trade.usdValue;
        acc.usdKnown = true;
      }
      acc.firstBuyUnix = Math.min(acc.firstBuyUnix, trade.blockUnixTime);
    } else {
      acc.sells += 1;
    }

    byWallet.set(trade.owner, acc);
  }

  const buyers = [...byWallet.entries()].filter(([, a]) => a.buys > 0);
  report.distinctEarlyBuyers = buyers.length;

  const earlyVolume = buyers.reduce((sum, [, a]) => sum + a.tokensBought, 0);

  // --- synchronised cohorts -------------------------------------------------
  // Wallets whose first buy landed within a few seconds of each other. On its
  // own this is weak — a launch draws a crowd — so it only ever contributes
  // alongside other signals.
  const ordered = [...buyers].sort((a, b) => a[1].firstBuyUnix - b[1].firstBuyUnix);
  const clusters: BuyCluster[] = [];
  let current: Array<[string, Acc]> = [];

  const flush = () => {
    if (current.length >= 3) {
      const combined = current.reduce((sum, [, a]) => sum + a.tokensBought, 0);
      clusters.push({
        id: clusters.length + 1,
        members: current.map(([address]) => address),
        atSecondsAfterLaunch: current[0][1].firstBuyUnix - launchUnix,
        combinedTokens: combined,
        combinedShareOfEarlyVolume: earlyVolume > 0 ? combined / earlyVolume : 0,
        membersLinkedToDeployer: 0, // filled once the funding graph is built
      });
    }
    current = [];
  };

  for (const entry of ordered) {
    if (!current.length) current = [entry];
    else if (entry[1].firstBuyUnix - current[0][1].firstBuyUnix <= CLUSTER_WINDOW_SECONDS) {
      current.push(entry);
    } else {
      flush();
      current = [entry];
    }
  }
  flush();

  const clusterOf = new Map<string, number>();
  for (const cluster of clusters) {
    for (const member of cluster.members) clusterOf.set(member, cluster.id);
  }

  // --- calibrate against this launch --------------------------------------
  /*
   * Speed is scored relative to the launch it happened at, not against a fixed
   * threshold. Sniping bots enter every launch indiscriminately, so on a token
   * where 87% of the opening book bought inside a minute, being fast describes
   * the crowd rather than distinguishing anyone from it. Scoring it flat would
   * mark almost every wallet as suspicious and bury the few that are actually
   * unusual — the precise failure that makes these tools useless.
   */
  const sniperCount = buyers.filter(
    ([, a]) => a.firstBuyUnix - launchUnix <= SNIPE_WINDOW_SECONDS
  ).length;
  const sniperRatio = buyers.length ? sniperCount / buyers.length : 0;
  const speedDiscount = sniperRatio > 0.5 ? 0.25 : sniperRatio > 0.25 ? 0.6 : 1;

  report.launchProfile = {
    sniperCount,
    sniperRatio,
    speedDiscount,
    botSwarm: sniperRatio > 0.5,
  };

  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

  /*
   * Scoring runs in two phases. Tracing a wallet's funding costs several
   * requests, so it is only worth spending on wallets that already look
   * notable — the opening book of a launch runs to hundreds of dust bots.
   * Phase one scores everything on trade behaviour alone and ranks it; phase
   * two traces the top of that list and folds the funding evidence back in.
   */
  const scoreOne = (
    address: string,
    acc: Acc,
    funding: {
      link: DeployerLink | null;
      sharedWith: string[];
      traced: boolean;
    }
  ): SuspectWallet => {
    const secondsAfterLaunch = acc.firstBuyUnix - launchUnix;
    const share = earlyVolume > 0 ? acc.tokensBought / earlyVolume : 0;
    const signals: ForensicSignal[] = [];
    let score = 0;

    if (secondsAfterLaunch <= 5) {
      const weight = Math.round(30 * speedDiscount);
      signals.push({
        code: 'same_block',
        detail:
          `Bought within ${secondsAfterLaunch}s of the first recorded trade — effectively the opening block.` +
          (speedDiscount < 1
            ? ` Discounted: ${(sniperRatio * 100).toFixed(0)}% of early buyers here were equally fast, which points to a bot swarm rather than to this wallet.`
            : ''),
        weight,
      });
      score += weight;
    } else if (secondsAfterLaunch <= SNIPE_WINDOW_SECONDS) {
      const weight = Math.round(18 * speedDiscount);
      signals.push({
        code: 'snipe',
        detail:
          `Bought ${secondsAfterLaunch}s after the first recorded trade, before most participants could react.` +
          (speedDiscount < 1
            ? ` Discounted: fast entry was the norm at this launch.`
            : ''),
        weight,
      });
      score += weight;
    }

    if (share >= 0.50) {
      signals.push({
        code: 'majority_of_book',
        detail: `Took ${(share * 100).toFixed(1)}% of all tokens bought across the sampled opening trades. One wallet accounting for most of the opening book means the early market was effectively this wallet.`,
        weight: 45,
      });
      score += 45;
    } else if (share >= 0.20) {
      signals.push({
        code: 'dominant_size',
        detail: `Took ${(share * 100).toFixed(1)}% of all tokens bought across the sampled opening trades — a dominant share of the opening book regardless of timing.`,
        weight: 35,
      });
      score += 35;
    } else if (share >= 0.10) {
      signals.push({
        code: 'size',
        detail: `Took ${(share * 100).toFixed(1)}% of all tokens bought across the sampled opening trades.`,
        weight: 25,
      });
      score += 25;
    } else if (share >= 0.03) {
      signals.push({
        code: 'size_moderate',
        detail: `Took ${(share * 100).toFixed(1)}% of tokens bought in the sampled opening trades.`,
        weight: 10,
      });
      score += 10;
    }

    const link = funding.link;
    const linkedToDeployer = link !== null;
    if (link) {
      const weight = link.kind === 'direct' ? 35 : 25;
      const amount = link.sol !== null ? ` (${link.sol.toFixed(2)} SOL on the smallest leg)` : '';
      signals.push({
        code: link.kind === 'direct' ? 'deployer_link' : 'deployer_link_indirect',
        detail:
          link.kind === 'direct'
            ? `Funded by the deployer wallet directly${amount}. A transfer only — it does not establish who controls either wallet.`
            : `Funded through ${link.path[1].slice(0, 4)}…${link.path[1].slice(-4)}, a wallet the deployer also funded${amount}. Two hops, so the connection is weaker than a direct transfer.`,
        weight,
      });
      score += weight;
    }

    if (funding.sharedWith.length) {
      signals.push({
        code: 'shared_funder',
        detail: `Shares a funding source with ${funding.sharedWith.length} other wallet${funding.sharedWith.length === 1 ? '' : 's'} in this launch. Exchange withdrawals are excluded from this signal.`,
        weight: 20,
      });
      score += 20;
    }

    const clusterId = clusterOf.get(address) ?? null;
    if (clusterId !== null) {
      const cluster = clusters.find((c) => c.id === clusterId)!;
      signals.push({
        code: 'synchronised',
        detail: `First buy landed within ${CLUSTER_WINDOW_SECONDS}s of ${cluster.members.length - 1} other wallets.`,
        weight: 12,
      });
      score += 12;
    }

    const stillHolding = holders.length ? holderShare.has(address) : null;
    if (stillHolding === true && secondsAfterLaunch <= SNIPE_WINDOW_SECONDS) {
      signals.push({
        code: 'held_from_launch',
        detail: 'Bought at launch and is still among the largest holders.',
        weight: 10,
      });
      score += 10;
    }
    if (
      stillHolding === false &&
      acc.sells > 0 &&
      secondsAfterLaunch <= SNIPE_WINDOW_SECONDS &&
      share >= 0.01
    ) {
      signals.push({
        code: 'sniped_and_exited',
        detail: 'Bought at launch, sold within the sampled window, and is no longer a large holder.',
        weight: 15,
      });
      score += 15;
    }

    /*
     * Size gate. A wallet that took a thousandth of the opening supply cannot
     * move the token whatever it knew, and the sampled book is full of them —
     * dust bots buying a fraction of a SOL. They are not worth a trader's
     * attention, so their score is scaled down rather than left to inflate the
     * "medium" bucket. Full weight from 2% of the opening volume upwards.
     */
    const materiality = 0.2 + 0.8 * clamp01(share / 0.02);
    const finalScore = Math.min(Math.round(score * materiality), 100);

    return {
      address,
      deployerLink: link,
      sharedFunderWith: funding.sharedWith,
      fundingTraced: funding.traced,
      secondsAfterLaunch,
      firstBuyAt: new Date(acc.firstBuyUnix * 1000).toISOString(),
      tokensBought: acc.tokensBought,
      usdBought: acc.usdKnown ? acc.usdBought : null,
      shareOfEarlyVolume: share,
      buyCount: acc.buys,
      sellCount: acc.sells,
      stillHolding,
      pctOfSupply: holderShare.get(address) ?? null,
      linkedToDeployer,
      clusterId,
      score: finalScore,
      level: levelFor(finalScore),
      signals,
    };
  };

  const noFunding = { link: null, sharedWith: [] as string[], traced: false };

  // Phase one: behaviour only.
  const preliminary = buyers
    .map(([address, acc]) => ({ address, acc, scored: scoreOne(address, acc, noFunding) }))
    .sort(
      (a, b) =>
        b.scored.score - a.scored.score ||
        b.scored.shareOfEarlyVolume - a.scored.shareOfEarlyVolume
    );

  // Phase two: trace the funding of the wallets that already stand out.
  const graph = await buildFundingGraph({
    deployer,
    candidates: preliminary.slice(0, MAX_TRACED_CANDIDATES).map((entry) => entry.address),
    allBuyers: preliminary.map((entry) => entry.address),
    counter: walkCounter,
  });

  const linkByCandidate = new Map(graph.links.map((link) => [link.candidate, link]));
  const sharedByCandidate = new Map<string, string[]>();
  for (const group of graph.sharedFunders) {
    // A shared exchange hot wallet groups thousands of unrelated people, so it
    // is reported for context but never scored as a connection.
    if (group.likelyService) continue;
    for (const member of group.members) {
      sharedByCandidate.set(member, [
        ...(sharedByCandidate.get(member) ?? []),
        ...group.members.filter((m) => m !== member),
      ]);
    }
  }

  const suspects = preliminary.map((entry) =>
    scoreOne(entry.address, entry.acc, {
      link: linkByCandidate.get(entry.address) ?? null,
      sharedWith: [...new Set(sharedByCandidate.get(entry.address) ?? [])],
      traced: graph.traces.has(entry.address),
    })
  );

  suspects.sort((a, b) => b.score - a.score || a.secondsAfterLaunch - b.secondsAfterLaunch);

  // Now that links are known, cohorts can report how many members carry one.
  const linkedSet = new Set(graph.links.map((link) => link.candidate));
  for (const cluster of clusters) {
    cluster.membersLinkedToDeployer = cluster.members.filter((m) => linkedSet.has(m)).length;
  }

  report.suspects = suspects.slice(0, 25);
  report.clusters = clusters;
  report.sharedFunders = graph.sharedFunders;
  report.funding = graph.stats;
  report.deployer.counterpartiesScanned = graph.stats.deployerOutboundWallets;
  limitations.push(...graph.notes);

  // --- summary -------------------------------------------------------------
  const high = suspects.filter((s) => s.level === 'high');
  const linked = suspects.filter((s) => s.linkedToDeployer);
  const snipers = suspects.filter((s) => s.secondsAfterLaunch <= SNIPE_WINDOW_SECONDS);
  const sniperShare = snipers.reduce((sum, s) => sum + s.shareOfEarlyVolume, 0);

  report.summary.push(
    `${buyers.length} distinct wallets bought across the first ${trades.length} recorded trades.`
  );
  if (snipers.length) {
    report.summary.push(
      `${snipers.length} bought within ${SNIPE_WINDOW_SECONDS}s of the first trade, together taking ${(sniperShare * 100).toFixed(1)}% of the tokens bought in that sample.`
    );
  }
  if (report.launchProfile.botSwarm) {
    report.summary.push(
      `${(sniperRatio * 100).toFixed(0)}% of early buyers entered inside the first minute, which is the signature of automated snipers competing for a launch. Speed has been discounted accordingly here — size and deployer links carry the weight instead.`
    );
  }
  if (linked.length) {
    const direct = linked.filter((l) => l.deployerLink?.kind === 'direct').length;
    const indirect = linked.length - direct;
    report.summary.push(
      `Funding traces back to the deployer for ${linked.length} of the wallets examined` +
        (indirect
          ? ` — ${direct} funded directly, ${indirect} through an intermediary wallet the deployer also funded.`
          : ', by direct transfer.')
    );
  }

  const realGroups = report.sharedFunders.filter((g) => !g.likelyService);
  if (realGroups.length) {
    const grouped = new Set(realGroups.flatMap((g) => g.members)).size;
    report.summary.push(
      `${grouped} wallets were funded from ${realGroups.length} shared source${realGroups.length === 1 ? '' : 's'} that do not look like exchanges — the clearest sign in this report that separate wallets were not independently funded.`
    );
  }
  const serviceGroups = report.sharedFunders.length - realGroups.length;
  if (serviceGroups > 0) {
    report.summary.push(
      `${serviceGroups} further shared funding source${serviceGroups === 1 ? '' : 's'} were excluded as exchange or bot infrastructure, which thousands of unrelated wallets share.`
    );
  }
  if (clusters.length) {
    report.summary.push(
      `${clusters.length} synchronised cohort${clusters.length === 1 ? '' : 's'} detected — groups of three or more wallets whose first buys landed within ${CLUSTER_WINDOW_SECONDS}s of each other.`
    );
  }
  report.summary.push(
    high.length
      ? high.length === 1
        ? '1 wallet combines several of these patterns and is the one worth inspecting first.'
        : `${high.length} wallets combine several of these patterns and are the ones worth inspecting first.`
      : 'No wallet combined enough patterns to stand out from ordinary launch activity.'
  );

  // --- limitations ----------------------------------------------------------
  limitations.push(
    `Analysis covers the first ${trades.length} recorded trades only; activity after that window is not considered.`
  );
  limitations.push(
    `Funding was traced for the ${report.funding.candidatesTraced} highest-ranked wallets only, two hops from the deployer at most. A wallet further down the list, or connected through a longer chain, would not show a link — an absent link is not evidence of independence.`
  );
  if (deployer) {
    const ageDays = (Date.now() / 1000 - launchUnix) / 86_400;
    if (ageDays > 30) {
      limitations.push(
        `This token launched ${Math.round(ageDays)} days ago. The deployer-side walk covers that wallet's recent transactions, so transfers made around the launch itself may fall outside it; the candidate-side walk compensates only as far as each wallet's own history budget reaches.`
      );
    }
  }
  limitations.push(
    'Wallets are not identities. One person may run many wallets, and one wallet may be a shared or custodial account.'
  );
  limitations.push(
    'Fast buying is not by itself improper. Sniping bots enter every launch automatically and will score here exactly like a wallet with prior knowledge.'
  );

  return report;
}

export { SNIPE_WINDOW_SECONDS, CLUSTER_WINDOW_SECONDS, NATIVE_SOL };
