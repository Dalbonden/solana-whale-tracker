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
 * WHY SHARED FUNDERS ARE MOSTLY BORING
 *
 * The majority of wallets are funded by an exchange. Thousands of unrelated
 * people withdraw from the same hot wallet, so "shared funder" on its own means
 * almost nothing. Rather than guess at a list of exchange addresses — and
 * mislabel a real wallet as infrastructure — service wallets are detected
 * structurally, from transaction velocity: an address pushing a hundred
 * transactions in minutes is not a person.
 */

import * as helius from '@/lib/providers/helius';
import type { HeliusEnhancedTransaction } from '@/lib/providers/helius';
import { identifyAddress, isNonDiscretionaryHolder } from '@/lib/solana/entities';
import { mapWithConcurrency } from '@/lib/providers/http';

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Ignore dust: rent-exemption top-ups and spam are not funding. */
const MIN_FUNDING_SOL = 0.01;

/** Pages walked backwards when looking for a wallet's earliest funding. */
const CANDIDATE_PAGES = 3;
/** Pages of deployer history scanned. */
const DEPLOYER_PAGES = 3;
/** Wallets funded by the deployer that get expanded one hop further. */
const HOP_EXPANSION = 18;
/** Candidates whose funding is traced. Ranked by preliminary score. */
export const MAX_TRACED_CANDIDATES = 10;

/**
 * Strictly serial. Helius answers 429 under even modest parallelism on the free
 * tier, and a rate-limited walk produces a *different report for the same
 * token* — links appearing and vanishing between runs. A forensic tool that is
 * not reproducible is worthless, so throughput is traded for determinism.
 *
 * Tracing is
 * a background-quality job, so it queues rather than races: a rate-limited page
 * returns nothing, and nothing is indistinguishable from "this wallet has no
 * funder" unless it is tracked separately — which is exactly the kind of
 * failure-as-finding this report must not produce.
 */
const TRACE_CONCURRENCY = 1;

/**
 * A hundred transactions inside this window marks an address as a service —
 * exchange hot wallet, market maker, bot dispatcher. No individual transacts
 * at that rate, and treating one as a meaningful "shared funder" would group
 * every unrelated wallet that ever withdrew from the same exchange.
 */
const SERVICE_VELOCITY_SECONDS = 3600;

export interface FundingSource {
  address: string;
  sol: number;
  at: number;
  signature: string;
}

export interface FundingTrace {
  address: string;
  /** Earliest inbound SOL transfers we could observe, oldest first. */
  sources: FundingSource[];
  /**
   * True when paging reached the wallet's first transaction, which is the only
   * case where `sources` really is where the wallet's SOL came from. Short of
   * that, these are simply the earliest transfers within the pages scanned —
   * for a bot running hundreds of transactions an hour, that is trading flow,
   * not origin.
   */
  originConfirmed: boolean;
  /** The walk was cut short by an API error rather than by the page budget. */
  failed: boolean;
  pagesScanned: number;
}

export type LinkKind = 'direct' | 'one_hop' | 'funded_by_deployer_peer';

export interface DeployerLink {
  candidate: string;
  kind: LinkKind;
  /** deployer → … → candidate. */
  path: string[];
  /** SOL that moved on the weakest edge of the path, for context. */
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
  traces: Map<string, FundingTrace>;
  stats: {
    candidatesTraced: number;
    /** Wallets whose funding origin was actually established. */
    candidatesReachedGenesis: number;
    /** Walks abandoned because the API errored or rate-limited. */
    tracesFailed: number;
    deployerOutboundWallets: number;
    hopWalletsExpanded: number;
    requests: number;
  };
  notes: string[];
}

/** Pages an address's history backwards, newest first, up to `pages`. */
async function history(
  address: string,
  pages: number,
  counter: { requests: number; failures: number }
): Promise<{
  transactions: HeliusEnhancedTransaction[];
  reachedGenesis: boolean;
  failed: boolean;
}> {
  const transactions: HeliusEnhancedTransaction[] = [];
  let before: string | undefined;
  let reachedGenesis = false;
  let failed = false;

  for (let page = 0; page < pages; page += 1) {
    counter.requests += 1;

    let batch: HeliusEnhancedTransaction[];
    try {
      batch = await helius.getEnhancedHistory(address, { limit: 100, before });
    } catch {
      // A rate limit or timeout is missing evidence, never evidence of absence.
      failed = true;
      counter.failures += 1;
      break;
    }

    if (!batch.length) {
      reachedGenesis = true;
      break;
    }
    transactions.push(...batch);

    if (batch.length < 100) {
      reachedGenesis = true;
      break;
    }
    before = batch[batch.length - 1]?.signature;
  }

  return { transactions, reachedGenesis, failed };
}

interface Edge {
  from: string;
  to: string;
  sol: number;
  at: number;
  signature: string;
}

/**
 * SOL movement between wallets, ignoring dust and self-transfers.
 *
 * Reads `nativeTransfers` first, then falls back to balance deltas. The
 * fallback matters more than it looks: a wallet can be the subject of a
 * transaction whose `nativeTransfers` list never names it — SOL routed through
 * a program shows up only as a balance change — and reading transfers alone
 * silently reports such a wallet as having no funding at all.
 */
function nativeEdges(transactions: HeliusEnhancedTransaction[]): Edge[] {
  const edges: Edge[] = [];

  for (const tx of transactions) {
    const named = new Set<string>();

    for (const transfer of tx.nativeTransfers ?? []) {
      const { fromUserAccount: from, toUserAccount: to } = transfer;
      if (!from || !to || from === to) continue;

      const sol = (transfer.amount ?? 0) / LAMPORTS_PER_SOL;
      if (sol < MIN_FUNDING_SOL) continue;

      named.add(from);
      named.add(to);
      edges.push({ from, to, sol, at: tx.timestamp, signature: tx.signature });
    }

    // Balance-delta fallback for accounts the transfer list did not mention.
    const deltas = (tx.accountData ?? [])
      .filter((entry) => entry.account && Math.abs(entry.nativeBalanceChange) > 0)
      .sort((a, b) => a.nativeBalanceChange - b.nativeBalanceChange);
    if (deltas.length < 2) continue;

    const payer = deltas[0];
    if (payer.nativeBalanceChange >= 0) continue;

    for (const entry of deltas) {
      if (entry.account === payer.account) continue;
      if (named.has(entry.account)) continue;

      const sol = entry.nativeBalanceChange / LAMPORTS_PER_SOL;
      // Fees and rent are not funding, and the payer is charged both.
      if (sol < MIN_FUNDING_SOL) continue;

      edges.push({
        from: payer.account,
        to: entry.account,
        sol,
        at: tx.timestamp,
        signature: tx.signature,
      });
    }
  }

  return edges;
}

/**
 * Velocity test for service addresses.
 *
 * Deliberately structural rather than a hardcoded exchange list. Guessing at
 * exchange addresses risks labelling a real participant as infrastructure,
 * which understates a finding exactly as badly as the reverse overstates it.
 */
function looksLikeService(transactions: HeliusEnhancedTransaction[]): boolean {
  if (transactions.length < 100) return false;
  const newest = transactions[0]?.timestamp ?? 0;
  const oldest = transactions[transactions.length - 1]?.timestamp ?? 0;
  const span = newest - oldest;
  return span > 0 && span < SERVICE_VELOCITY_SECONDS;
}

/**
 * Recovers a token's creator from the mint's own first transaction.
 *
 * Needed because the obvious source is useless on exactly the launches that
 * matter most. A pump.fun mint has no meaningful update authority — it reports
 * the System Program — so metadata alone leaves every pump.fun token without a
 * deployer, and pump.fun is where launch forensics is most often wanted.
 *
 * The mint's oldest transaction is its creation, and that transaction's fee
 * payer is whoever paid to create it. Paging a mint back to genesis is cheap
 * for a young token and expensive for an old one, so the walk is capped and
 * simply gives up rather than guessing.
 */
export async function findMintCreator(
  mint: string,
  counter: { requests: number; failures: number },
  maxPages = 5
): Promise<{ address: string | null; via: 'mint_creation' | null }> {
  const { transactions, reachedGenesis } = await history(mint, maxPages, counter);
  if (!reachedGenesis || !transactions.length) return { address: null, via: null };

  // History comes back newest-first, so the creation transaction is last.
  const genesis = transactions[transactions.length - 1];
  const payer = genesis?.feePayer;
  if (!payer) return { address: null, via: null };

  // A launchpad paying the fee is the platform, not the person.
  if (identifyAddress(payer).kind !== 'unidentified') return { address: null, via: null };

  return { address: payer, via: 'mint_creation' };
}

/** Earliest inbound SOL for one wallet, within a page budget. */
export async function traceFunding(
  address: string,
  counter: { requests: number; failures: number }
): Promise<FundingTrace> {
  const { transactions, reachedGenesis, failed } = await history(address, CANDIDATE_PAGES, counter);

  const inbound = nativeEdges(transactions)
    .filter((edge) => edge.to === address)
    .sort((a, b) => a.at - b.at);

  // Only the earliest few matter. Later top-ups say nothing about origin.
  const sources: FundingSource[] = [];
  const seen = new Set<string>();
  for (const edge of inbound) {
    if (seen.has(edge.from)) continue;
    seen.add(edge.from);
    sources.push({ address: edge.from, sol: edge.sol, at: edge.at, signature: edge.signature });
    if (sources.length >= 3) break;
  }

  return {
    address,
    sources,
    originConfirmed: reachedGenesis && !failed,
    failed,
    pagesScanned: Math.ceil(transactions.length / 100) || 1,
  };
}

/**
 * Builds the funding graph around a launch.
 *
 * `candidates` should already be ranked — only the first
 * `MAX_TRACED_CANDIDATES` are traced, because each costs several requests.
 */
export async function buildFundingGraph(opts: {
  deployer: string | null;
  /** Wallets whose own history is walked. Expensive, so keep this ranked. */
  candidates: string[];
  /**
   * Every early buyer. Checking these against the deployer's outbound set costs
   * nothing extra — the set is already in memory — so a direct link is caught
   * even for a wallet too far down the ranking to be worth tracing.
   */
  allBuyers?: string[];
}): Promise<FundingGraph> {
  const counter = { requests: 0, failures: 0 };
  const notes: string[] = [];
  const { deployer } = opts;
  const candidates = opts.candidates.slice(0, MAX_TRACED_CANDIDATES);

  // --- deployer side: who did it fund, and who did they fund ---------------
  const deployerFunded = new Map<string, number>();
  const hopRecipients = new Map<string, Set<string>>();

  let deployerScanFailed = false;
  if (deployer) {
    const { transactions, failed } = await history(deployer, DEPLOYER_PAGES, counter);
    deployerScanFailed = failed;
    for (const edge of nativeEdges(transactions)) {
      if (edge.from !== deployer) continue;
      if (isNonDiscretionaryHolder(identifyAddress(edge.to).kind)) continue;
      deployerFunded.set(edge.to, (deployerFunded.get(edge.to) ?? 0) + edge.sol);
    }

    // Expand the largest recipients one hop. Largest first because a wallet the
    // deployer sent 40 SOL to is a plausible intermediary; one it sent 0.02 to
    // is noise.
    const toExpand = [...deployerFunded.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, HOP_EXPANSION)
      .map(([address]) => address);

    await mapWithConcurrency(toExpand, TRACE_CONCURRENCY, async (address) => {
      const { transactions: hopTxs } = await history(address, 1, counter);
      const recipients = new Set<string>();
      for (const edge of nativeEdges(hopTxs)) {
        if (edge.from === address) recipients.add(edge.to);
      }
      hopRecipients.set(address, recipients);
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
  const traces = new Map<string, FundingTrace>();
  await mapWithConcurrency(candidates, TRACE_CONCURRENCY, async (address) => {
    traces.set(address, await traceFunding(address, counter));
  });

  // --- service detection for funders that group several candidates ---------
  const funderMembers = new Map<string, string[]>();
  const funderSol = new Map<string, number>();
  for (const [candidate, trace] of traces) {
    // An unconfirmed origin is a counterparty, not a funder. Grouping on those
    // would cluster unrelated bots that happened to receive from the same
    // router within the pages scanned.
    if (!trace.originConfirmed) continue;
    for (const source of trace.sources) {
      if (source.address === deployer) continue; // that is a direct link, not a group
      funderMembers.set(source.address, [...(funderMembers.get(source.address) ?? []), candidate]);
      funderSol.set(source.address, (funderSol.get(source.address) ?? 0) + source.sol);
    }
  }

  const grouped = [...funderMembers.entries()].filter(([, members]) => members.length >= 2);

  const sharedFunders: SharedFunderGroup[] = [];
  await mapWithConcurrency(grouped, TRACE_CONCURRENCY, async ([funder, members]) => {
    const entity = identifyAddress(funder);
    const { transactions } = await history(funder, 1, counter);
    sharedFunders.push({
      funder,
      members,
      totalSol: funderSol.get(funder) ?? 0,
      likelyService: looksLikeService(transactions),
      label: entity.kind === 'unidentified' ? null : entity.label,
    });
  });

  sharedFunders.sort((a, b) => Number(a.likelyService) - Number(b.likelyService) || b.members.length - a.members.length);

  // --- resolve links --------------------------------------------------------
  const links: DeployerLink[] = [];

  if (deployer) {
    // Cheap pass first: anyone the deployer paid directly, traced or not.
    const cheapScope = new Set([...(opts.allBuyers ?? []), ...candidates]);
    // The deployer buying its own token is worth knowing, but it is not a
    // "funding link" — reporting deployer → x → deployer as a connection is
    // just noise with a self-referential path.
    cheapScope.delete(deployer);
    for (const candidate of cheapScope) {
      const trace = traces.get(candidate);

      // Direct: the deployer funded this wallet, seen from either side.
      if (deployerFunded.has(candidate)) {
        links.push({
          candidate,
          kind: 'direct',
          path: [deployer, candidate],
          sol: deployerFunded.get(candidate) ?? null,
        });
        continue;
      }

      const confirmed = trace?.originConfirmed ? trace : undefined;
      const fromDeployer = confirmed?.sources.find((s) => s.address === deployer);
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
      const viaSource = confirmed?.sources.find((s) => deployerFunded.has(s.address));
      if (viaSource) {
        links.push({
          candidate,
          kind: 'one_hop',
          path: [deployer, viaSource.address, candidate],
          sol: Math.min(viaSource.sol, deployerFunded.get(viaSource.address) ?? viaSource.sol),
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

  const confirmed = [...traces.values()].filter((t) => t.originConfirmed).length;
  const failed = [...traces.values()].filter((t) => t.failed).length;

  if (failed > 0) {
    notes.push(
      `${failed} of ${candidates.length} funding walks were cut short by API rate limits, so those wallets were not checked at all. That is missing data, not an absence of connections.`
    );
  }
  const budgetLimited = candidates.length - confirmed - failed;
  if (budgetLimited > 0) {
    notes.push(
      `${budgetLimited} wallets have more history than the ${CANDIDATE_PAGES}-page budget covers, so their original funding source was never reached and they were excluded from link and shared-source detection. High-frequency bots fall into this group; wallets created shortly before the launch generally do not.`
    );
  }

  return {
    links,
    sharedFunders,
    traces,
    stats: {
      candidatesTraced: candidates.length,
      candidatesReachedGenesis: confirmed,
      tracesFailed: failed,
      deployerOutboundWallets: deployerFunded.size,
      hopWalletsExpanded: hopRecipients.size,
      requests: counter.requests,
    },
    notes,
  };
}
