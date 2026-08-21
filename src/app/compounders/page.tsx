import { AlertTriangle, Info, TrendingDown, TrendingUp } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { SetupNotice } from '@/components/setup-notice';
import { StatCards, type Stat } from '@/components/stat-cards';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { buildCompoundersBoard } from '@/lib/core/compounders';
import { MIN_POINTS, MIN_SPAN_HOURS } from '@/lib/core/wealth';
import { getTokenPrices, listPositions, listWhales } from '@/lib/db/repositories';
import { cn, formatUsd, shortenAddress } from '@/lib/utils';

export const metadata: Metadata = { title: 'Compounders' };
export const dynamic = 'force-dynamic';

const VERDICT_STYLES: Record<string, string> = {
  compounding: 'border-[hsl(var(--bull)/0.4)] bg-[hsl(var(--bull)/0.12)] text-[hsl(var(--bull))]',
  bleeding: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  tracking: 'border-border bg-muted/40 text-muted-foreground',
  insufficient: 'border-border bg-muted/30 text-muted-foreground',
};

const VERDICT_LABEL: Record<string, string> = {
  compounding: 'Compounding',
  bleeding: 'Bleeding',
  tracking: 'Tracking market',
  insufficient: 'Building history',
};

export default async function CompoundersPage() {
  let board;
  try {
    const { rows: whales } = await listWhales({ pageSize: 100, sort: 'score' });

    // Prices for marking open positions, fetched once for the whole board.
    const mints = new Set<string>();
    for (const whale of whales) {
      const positions = await listPositions(whale.address).catch(() => []);
      for (const position of positions) mints.add(position.token_mint);
    }
    const prices = await getTokenPrices([...mints]);

    board = await buildCompoundersBoard(whales, { prices });
  } catch (error) {
    return (
      <div className="space-y-6">
        <Header />
        <SetupNotice error={(error as Error).message} />
      </div>
    );
  }

  const compounding = board.rows.filter((r) => r.verdict === 'compounding').length;
  const profitable = board.rows.filter((r) => (r.tradingPnlUsd ?? 0) > 0).length;
  const totalPnl = board.rows.reduce((sum, r) => sum + (r.tradingPnlUsd ?? 0), 0);

  const cards: Stat[] = [
    { label: 'Wallets ranked', value: String(board.rows.length) },
    {
      label: 'Profitable',
      value: `${profitable}/${board.rows.length}`,
      tone: profitable > board.rows.length / 2 ? 'bull' : 'bear',
      hint: 'by trading P&L',
    },
    {
      label: 'Combined trading P&L',
      value: `${totalPnl >= 0 ? '+' : ''}${formatUsd(totalPnl)}`,
      tone: totalPnl >= 0 ? 'bull' : 'bear',
    },
    {
      label: 'Net worth measurable',
      value: `${board.measurable}/${board.rows.length}`,
      hint: `${board.snapshotDepth} snapshots recorded`,
    },
    {
      label: 'Compounding',
      value: String(compounding),
      hint: 'beating the cohort',
      tone: compounding > 0 ? 'bull' : undefined,
    },
    {
      label: 'Cohort median',
      value:
        board.cohortMedianPct === null
          ? '—'
          : `${board.cohortMedianPct >= 0 ? '+' : ''}${(board.cohortMedianPct * 100).toFixed(1)}%`,
      hint: 'the benchmark',
    },
  ];

  return (
    <div className="space-y-6">
      <Header />
      <StatCards stats={cards} />

      {board.measurable === 0 && (
        <div className="flex gap-2 rounded-md border border-border bg-muted/30 p-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Net-worth trajectory needs at least {MIN_POINTS} portfolio snapshots spanning{' '}
            {MIN_SPAN_HOURS}h per wallet, and only {board.snapshotDepth} snapshot
            {board.snapshotDepth === 1 ? ' has' : 's have'} been recorded so far. Until then the
            board ranks by trading P&amp;L, which is measurable today. Run{' '}
            <code>/api/cron/portfolios</code> on a schedule to build the history — every run adds a
            point to every wallet&apos;s curve.
          </p>
        </div>
      )}

      <div className="surface overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Wallet</TableHead>
              <TableHead>Verdict</TableHead>
              <TableHead className="text-right">Portfolio</TableHead>
              <TableHead className="text-right">Trading P&amp;L</TableHead>
              <TableHead className="text-right">Realised</TableHead>
              <TableHead className="text-right">Net worth Δ</TableHead>
              <TableHead className="text-right">vs cohort</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {board.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  No whales tracked yet.
                </TableCell>
              </TableRow>
            )}

            {board.rows.map((row) => (
              <TableRow key={row.address}>
                <TableCell>
                  <Link
                    href={`/whales/${row.address}`}
                    className="font-mono text-xs hover:text-primary"
                  >
                    {row.label ?? shortenAddress(row.address, 6)}
                  </Link>
                  {row.attribution && (
                    <p
                      className="mt-0.5 flex items-start gap-1 text-[10px] text-amber-400/90"
                      title={row.attribution}
                    >
                      <AlertTriangle className="mt-px h-2.5 w-2.5 shrink-0" />
                      {row.attribution.startsWith('Only')
                        ? `${((row.coverage ?? 0) * 100).toFixed(1)}% of book tracked`
                        : 'transfers, not performance'}
                    </p>
                  )}
                </TableCell>

                <TableCell>
                  <span
                    className={cn(
                      'inline-flex rounded-md border px-2 py-0.5 text-[10px] font-medium',
                      VERDICT_STYLES[row.verdict]
                    )}
                    title={row.trajectory.shortfall ?? undefined}
                  >
                    {VERDICT_LABEL[row.verdict]}
                  </span>
                </TableCell>

                <TableCell className="tabular text-right text-xs">
                  {formatUsd(row.portfolioUsd)}
                </TableCell>

                <TableCell className="tabular text-right text-xs">
                  {row.tradingPnlUsd === null ? (
                    <span
                      className="text-muted-foreground"
                      title="No position with a known entry price yet"
                    >
                      —
                    </span>
                  ) : (
                    <span
                      className={
                        row.tradingPnlUsd >= 0
                          ? 'text-[hsl(var(--bull))]'
                          : 'text-[hsl(var(--bear))]'
                      }
                    >
                      {row.tradingPnlUsd >= 0 ? '+' : ''}
                      {formatUsd(row.tradingPnlUsd)}
                    </span>
                  )}
                  {row.unmarkedPositions > 0 && (
                    <span
                      className="ml-1 text-[10px] text-muted-foreground"
                      title={`${row.unmarkedPositions} open position(s) could not be marked, so this is partial`}
                    >
                      ({row.unmarkedPositions}?)
                    </span>
                  )}
                </TableCell>

                <TableCell className="tabular text-right text-xs text-muted-foreground">
                  {row.realisedUsd === 0 ? '—' : formatUsd(row.realisedUsd)}
                </TableCell>

                <TableCell className="tabular text-right text-xs">
                  {row.trajectory.sufficient && row.trajectory.changeUsd !== null ? (
                    <span
                      className={
                        row.trajectory.changeUsd >= 0
                          ? 'text-[hsl(var(--bull))]'
                          : 'text-[hsl(var(--bear))]'
                      }
                    >
                      {row.trajectory.changeUsd >= 0 ? '+' : ''}
                      {formatUsd(row.trajectory.changeUsd)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground" title={row.trajectory.shortfall ?? ''}>
                      —
                    </span>
                  )}
                </TableCell>

                <TableCell className="tabular text-right text-xs">
                  {row.relativeGrowthPp === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span
                      className={cn(
                        'inline-flex items-center gap-1',
                        row.relativeGrowthPp >= 0
                          ? 'text-[hsl(var(--bull))]'
                          : 'text-[hsl(var(--bear))]'
                      )}
                    >
                      {row.relativeGrowthPp >= 0 ? (
                        <TrendingUp className="h-3 w-3" />
                      ) : (
                        <TrendingDown className="h-3 w-3" />
                      )}
                      {row.relativeGrowthPp >= 0 ? '+' : ''}
                      {row.relativeGrowthPp.toFixed(1)}pp
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <div className="space-y-1.5 border-t border-border px-3 py-3">
          <p className="text-[11px] text-muted-foreground">
            <strong className="font-medium text-foreground">Trading P&amp;L</strong> is realised plus
            unrealised on positions whose entry we observed. It is attributable to trading, but
            blind to holdings outside the tracked meme universe.
          </p>
          <p className="text-[11px] text-muted-foreground">
            <strong className="font-medium text-foreground">Net worth Δ</strong> is the whole book,
            measured from our own snapshots. It covers everything but includes deposits and market
            moves, so it is judged against the cohort median rather than in absolute terms — a
            wallet only counts as compounding if it outgrew the wallets beside it.
          </p>
          <p className="text-[11px] text-muted-foreground">
            When the two disagree sharply the balance moved for reasons trading cannot explain, and
            the row is flagged rather than credited. Where our ledger covers too little of a wallet
            to make that comparison meaningful, the row says how much is tracked instead of
            inventing a reason.
          </p>
        </div>
      </div>
    </div>
  );
}

function Header() {
  return (
    <div>
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        Compounders
        <Badge variant="outline" className="text-[10px]">
          beta
        </Badge>
      </h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Who is actually getting richer. Any explorer can show what a wallet holds right now; this
        ranks wallets by whether that number is going up, measured against the rest of the roster so
        a market-wide rally does not read as skill.
      </p>
    </div>
  );
}
