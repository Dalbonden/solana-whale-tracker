/**
 * Funding-graph reconstruction.
 *
 * Answers "where did this wallet's SOL come from, and does that trace back to
 * the deployer or to the same source as another wallet here".
 *
 * THE BUDGET PROBLEM
 *
 * Both obvious approaches are unbounded. Walking forward from the deployer only
 * sees its most recent transactions, which for a token launched two years ago
 * are nowhere near the launch. Walking backward from a candidate to its first
 * funding means paging to that wallet's genesis, and a wallet that has been
 * active since then has thousands of transactions in the way.
 *
 * So this walks from both ends and meets in the middle:
 *
 *   deployer  ──outbound──▶  wallets it funded  ──outbound──▶  their recipients
 *                                     ▲                              ▲
 *                                     └──────── candidate ───────────┘
 *                                          (earliest inbound SOL)
 *
 * A candidate connects if its funder is the deployer (direct), or is a wallet
 * the deployer funded (one hop). Two candidates connect to each other if they
 * share a funder, which needs no deployer involvement at all and is often the
 * stronger signal.
 *
 * Every walk is capped, and whatever the cap truncates is reported rather than
 * quietly presented as absence. A wallet whose history we could not reach is
 * "not traced", never "independent".
 *
 * The cap is per *visit*, not per wallet. `trace-store` remembers each wallet's
 * paging cursor, so a wallet seen at three launches has been walked three times
 * as deep as one seen once — and sniper wallets recur constantly, so the
 * wallets that matter deepen fastest.
 *
 * WHY SHARED FUNDERS ARE MOSTLY BORING
 *
 * The majority of wallets are funded by an exchange. Thousands of unrelated
 * people withdraw from the same hot wallet, so "shared funder" on its own means
 * almost nothing. Rather than guess at a list of exchange addresses — and
 * mislabel a real wallet as infrastructure — service wallets are detected
 * structurally, from transaction velocity.
 */

import { mapWithConcurrency } from '@/lib/providers/http';
import { identifyAddress, isNonDiscretionaryHolder } from '@/lib/solana/entities';

import {
  ensureTrace,
  extendTrace,
  loadTraces,
  newCounter,
  type WalkCounter,
  type WalletTrace,
} from './trace-store';

/** Pages added to a candidate's walk per visit. */
const CANDIDATE_PAGES = 3;
/** Pages of deployer history walked. */
const DEPLOYER_PAGES = 3;
/** Pages walked when hunting a mint's creation transaction. */
const MINT_PAGES = 5;
/** Wallets funded by the deployer that get expanded one hop further. */
const HOP_EXPANSION = 18;
/** Candidates whose funding is walked. Ranked by preliminary score. */
export const MAX_TRACED_CANDIDATES = 10;

/**
 * Strictly serial. Helius answers 429 under even modest parallelism on the free
 * tier, and a rate-limited walk produces a *different report for the same
 * token* — links appearing and vanishing between runs. A forensic tool that is
 * not reproducible is worthless, so throughput is traded for determinism.
 *
 * The cache is what keeps that affordable: most visits do no network work.
 */
const TRACE_CONCURRENCY = 1;

export type LinkKind = 'direct' | 'one_hop' | 'funded_by_deployer_peer';

export interface DeployerLink {
  candidate: string;
  kind: LinkKind;
  /** deployer → … → candidate. */
  path: string[];
  /** SOL observed on the deployer-side leg of the path. */
  sol: number | null;
}

export interface SharedFunderGroup {
  funder: string;
  members: string[];
  totalSol: number;
  /** Transaction velocity marks this as an exchange or bot dispatcher. */
  likelyService: boolean;
  /** Set when the funder is in the curated registry. */
  label: string | null;
}

export interface FundingGraph {
  links: DeployerLink[];
  sharedFunders: SharedFunderGroup[];
  traces: Map<string, WalletTrace>;
  stats: {
    candidatesTraced: number;
    /** Wallets whose funding origin was actually established. */
    candidatesReachedGenesis: number;
    /** Walks abandoned because the API errored or rate-limited. */
    tracesFailed: number;
    deployerOutboundWallets: number;
    hopWalletsExpanded: number;
    requests: number;
    /** Walks served entirely from cache, doing no network work. */
    cacheHits: number;
    cacheMisses: number;
    cacheAvailable: boolean;
  };
  notes: string[];
}

/**
 * Recovers a token's creator from the mint's own first transaction.
 *
 * Needed because the obvious source is useless on exactly the launches that
 * matter most. A pump.fun mint has no meaningful update authority — it reports
 * the System Program — so metadata alone leaves every launchpad token without a
 * deployer, and launchpads are where forensics is most often wanted.
 *
 * The mint's oldest transaction is its creation, and that transaction's fee
 * payer is whoever paid to create it. Cached like any other walk, so a mint
 * analysed twice costs nothing the second time.
 */
export async function findMintCreator(
  mint: string,
  counter: WalkCounter
): Promise<{ address: string | null; via: 'mint_creation' | null }> {
  const trace = await ensureTrace(mint, MINT_PAGES, counter);
  if (!trace.originConfirmed || !trace.genesisFeePayer) return { address: null, via: null };

  // A launchpad paying the fee is the platform, not the person.
  if (identifyAddress(trace.genesisFeePayer).kind !== 'unidentified') {
    return { address: null, via: null };
  }

  return { address: trace.genesisFeePayer, via: 'mint_creation' };
}

/**
 * Builds the funding graph around a launch.
 *
 * `candidates` should already be ranked — only the first
 * `MAX_TRACED_CANDIDATES` are walked, because each may cost several requests.
 */
export async function buildFundingGraph(opts: {
  deployer: string | null;
  /** Wallets whose own history is walked. Expensive, so keep this ranked. */
  candidates: string[];
  /**
   * Every early buyer. Checking these against the deployer's outbound set costs
   * nothing extra — the set is already in memory — so a direct link is caught
   * even for a wallet too far down the ranking to be worth walking.
   */
  allBuyers?: string[];
  counter?: WalkCounter;
}): Promise<FundingGraph> {
  const counter = opts.counter ?? newCounter();
  const notes: string[] = [];
  const { deployer } = opts;
  const candidates = opts.candidates.slice(0, MAX_TRACED_CANDIDATES);

  // --- deployer side: who did it fund, and who did they fund ---------------
  const deployerFunded = new Map<string, number>();
  const hopRecipients = new Map<string, Set<string>>();
  let deployerScanFailed = false;

  if (deployer) {
    const trace = await ensureTrace(deployer, DEPLOYER_PAGES, counter, { needOutbound: true });
    deployerScanFailed = trace.lastWalkFailed;

    for (const recipient of trace.outbound) {
      if (isNonDiscretionaryHolder(identifyAddress(recipient.address).kind)) continue;
      deployerFunded.set(recipient.address, recipient.sol);
    }

    // Expand the largest recipients one hop. Largest first because a wallet the
    // deployer sent 40 SOL to is a plausible intermediary; one it sent 0.02 to
    // is noise.
    const toExpand = [...deployerFunded.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, HOP_EXPANSION)
      .map(([address]) => address);

    await mapWithConcurrency(toExpand, TRACE_CONCURRENCY, async (address) => {
      const hop = await ensureTrace(address, 1, counter, { needOutbound: true });
      hopRecipients.set(address, new Set(hop.outbound.map((r) => r.address)));
    });

    if (deployerScanFailed) {
      notes.push(
        'The deployer history walk was cut short by an API rate limit, so the deployer-side funding graph is incomplete for this run. Re-running may surface links that are missing here.'
      );
    } else if (!deployerFunded.size) {
      notes.push(
        'No outbound SOL transfers were found in the deployer history scanned, so no deployer-side funding graph could be built.'
      );
    }
  }

  // --- candidate side: where did each one's SOL come from ------------------
  // Loaded as one batch first, so cached wallets cost a single query between
  // them rather than one query each.
  const cached = await loadTraces(candidates, counter);
  const traces = new Map<string, WalletTrace>();

  await mapWithConcurrency(candidates, TRACE_CONCURRENCY, async (address) => {
    const base = cached.get(address);
    // Each visit adds pages rather than repeating the last ones.
    const trace = base
      ? await extendTrace(base, base.pagesWalked + CANDIDATE_PAGES, counter)
      : await ensureTrace(address, CANDIDATE_PAGES, counter);
    traces.set(address, trace);
  });

  // --- shared funders -------------------------------------------------------
  const funderMembers = new Map<string, string[]>();
  const funderSol = new Map<string, number>();
  for (const [candidate, trace] of traces) {
    // An unconfirmed origin is a counterparty, not a funder. Grouping on those
    // would cluster unrelated bots that happened to receive from the same
    // router within the pages walked.
    if (!trace.originConfirmed) continue;
    for (const source of trace.inbound) {
      if (source.address === deployer) continue; // that is a direct link, not a group
      funderMembers.set(source.address, [...(funderMembers.get(source.address) ?? []), candidate]);
      funderSol.set(source.address, (funderSol.get(source.address) ?? 0) + source.sol);
    }
  }

  const grouped = [...funderMembers.entries()].filter(([, members]) => members.length >= 2);
  const sharedFunders: SharedFunderGroup[] = [];

  await mapWithConcurrency(grouped, TRACE_CONCURRENCY, async ([funder, members]) => {
    const entity = identifyAddress(funder);
    // One page is enough to measure velocity, and it is cached afterwards.
    const trace = await ensureTrace(funder, 1, counter);
    sharedFunders.push({
      funder,
      members,
      totalSol: funderSol.get(funder) ?? 0,
      likelyService: trace.likelyService === true,
      label: entity.kind === 'unidentified' ? null : entity.label,
    });
  });

  sharedFunders.sort(
    (a, b) =>
      Number(a.likelyService) - Number(b.likelyService) || b.members.length - a.members.length
  );

  // --- resolve links --------------------------------------------------------
  const links: DeployerLink[] = [];

  if (deployer) {
    // Cheap pass first: anyone the deployer paid directly, walked or not.
    const cheapScope = new Set([...(opts.allBuyers ?? []), ...candidates]);
    // The deployer buying its own token is worth knowing, but it is not a
    // "funding link" — reporting deployer → x → deployer as a connection is
    // just noise with a self-referential path.
    cheapScope.delete(deployer);

    for (const candidate of cheapScope) {
      const trace = traces.get(candidate);
      const confirmed = trace?.originConfirmed ? trace : undefined;

      if (deployerFunded.has(candidate)) {
        links.push({
          candidate,
          kind: 'direct',
          path: [deployer, candidate],
          sol: deployerFunded.get(candidate) ?? null,
        });
        continue;
      }

      const fromDeployer = confirmed?.inbound.find((s) => s.address === deployer);
      if (fromDeployer) {
        links.push({
          candidate,
          kind: 'direct',
          path: [deployer, candidate],
          sol: fromDeployer.sol,
        });
        continue;
      }

      // One hop: this wallet's funder is itself a wallet the deployer funded.
      const viaSource = confirmed?.inbound.find((s) => deployerFunded.has(s.address));
      if (viaSource) {
        links.push({
          candidate,
          kind: 'one_hop',
          path: [deployer, viaSource.address, candidate],
          sol: deployerFunded.get(viaSource.address) ?? viaSource.sol,
        });
        continue;
      }

      // Reverse direction: a wallet the deployer funded later paid this one.
      const viaHop = [...hopRecipients.entries()].find(([, recipients]) =>
        recipients.has(candidate)
      );
      if (viaHop) {
        links.push({
          candidate,
          kind: 'funded_by_deployer_peer',
          path: [deployer, viaHop[0], candidate],
          sol: deployerFunded.get(viaHop[0]) ?? null,
        });
      }
    }
  }

  const confirmedCount = [...traces.values()].filter((t) => t.originConfirmed).length;
  const failed = [...traces.values()].filter((t) => t.lastWalkFailed).length;

  if (failed > 0) {
    notes.push(
      `${failed} of ${candidates.length} funding walks were cut short by API rate limits, so those wallets were not fully checked. That is missing data, not an absence of connections.`
    );
  }

  const budgetLimited = candidates.length - confirmedCount - failed;
  if (budgetLimited > 0) {
    notes.push(
      counter.cacheAvailable
        ? `${budgetLimited} wallets have more history than this pass could cover, so their original funding source was not reached and they were excluded from link and shared-source detection. Each analysis walks them further back, so re-running deepens the result rather than repeating it.`
        : `${budgetLimited} wallets have more history than the ${CANDIDATE_PAGES}-page budget covers, and with no trace cache every run restarts from the same point.`
    );
  }

  if (!counter.cacheAvailable) {
    notes.push(
      'The wallet_traces cache table is missing, so nothing walked here is remembered for next time. Apply supabase/migrations/002_wallet_traces.sql to let repeated analyses reach further back.'
    );
  }

  return {
    links,
    sharedFunders,
    traces,
    stats: {
      candidatesTraced: candidates.length,
      candidatesReachedGenesis: confirmedCount,
      tracesFailed: failed,
      deployerOutboundWallets: deployerFunded.size,
      hopWalletsExpanded: hopRecipients.size,
      requests: counter.requests,
      cacheHits: counter.cacheHits,
      cacheMisses: counter.cacheMisses,
      cacheAvailable: counter.cacheAvailable,
    },
    notes,
  };
}
