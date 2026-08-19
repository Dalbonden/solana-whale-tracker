import { ExternalLink } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AlertList } from '@/components/alert-list';
import { ArchetypePanel } from '@/components/archetype-badges';
import { PortfolioAllocation, PortfolioTimeline } from '@/components/portfolio-chart';
import { PositionsTable } from '@/components/positions-table';
import { SetupNotice } from '@/components/setup-notice';
import { StatCards, type Stat } from '@/components/stat-cards';
import { TradeHistory } from '@/components/trade-history';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { derivePositionView } from '@/lib/core/positions';
import { buildArchetypeMetrics } from '@/lib/core/wallet-profile';
import {
  getCurrentPortfolio,
  getPortfolioTimeline,
  getTokenPrices,
  getWhale,
  listAlerts,
  listPositions,
  listTrades,
} from '@/lib/db/repositories';
import { EXPLORERS } from '@/lib/solana/constants';
import {
  cn,
  formatAmount,
  formatPercent,
  formatPrice,
  formatUsd,
  isValidSolanaAddress,
  shortenAddress,
  tierColor,
  timeAgo,
} from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: { address: string };
}): Promise<Metadata> {
  return { title: `Whale ${shortenAddress(params.address)}` };
}

export default async function WhaleProfilePage({ params }: { params: { address: string } }) {
  const address = params.address;
  if (!isValidSolanaAddress(address)) notFound();

  let data;
  try {
    const whale = await getWhale(address);
    if (!whale) notFound();

    const [portfolio, timeline, trades, alerts, positions] = await Promise.all([
      getCurrentPortfolio(address),
      getPortfolioTimeline(address, 30),
      listTrades({ whale: address, pageSize: 100 }),
      listAlerts({ whale: address, pageSize: 25 }),
      listPositions(address),
    ]);

    // Positions are marked against the token cache rather than a live quote:
    // the cron refreshes it every few minutes, and a page render should not
    // fan out to a price API per holding.
    const prices = await getTokenPrices(positions.map((p) => p.token_mint));

    // Conviction is measured against the priced portfolio, not the stored
    // whale total — the latter is a snapshot that may predate today's moves.
    const bookValue =
      portfolio.reduce((sum, holding) => sum + holding.usd_value, 0) || whale.portfolio_value_usd;

    const positionViews = positions.map((position) =>
      derivePositionView(position, prices.get(position.token_mint) ?? null, bookValue)
    );

    // Classification is derived on read: a stored badge would go stale, and a
    // wrong "smart money" label is worse than a slightly slower page.
    const profile = (await buildArchetypeMetrics([whale]).catch(() => null))?.get(address) ?? null;

    data = {
      whale,
      portfolio,
      timeline,
      trades,
      alerts,
      positions: positionViews,
      archetypes: profile?.archetypes ?? [],
    };
  } catch (error) {
    if ((error as Error).message === 'NEXT_NOT_FOUND') throw error;
    return <SetupNotice error={(error as Error).message} />;
  }

  const { whale, portfolio, timeline, trades, alerts, positions, archetypes } = data;

  const memeHoldings = portfolio.filter((holding) => holding.is_meme);
  // A null price means no feed covered the mint — not that it is worthless.
  const pricedHoldings = portfolio.filter((h) => h.price_usd !== null);
  const unpricedHoldings = portfolio.filter((h) => h.price_usd === null);
  const currentValue = portfolio.reduce((sum, holding) => sum + holding.usd_value, 0);
  const memeValue = memeHoldings.reduce((sum, holding) => sum + holding.usd_value, 0);

  let boughtUsd = 0;
  let soldUsd = 0;
  for (const trade of trades.rows) {
    if (trade.side === 'buy') boughtUsd += trade.usd_value;
    else soldUsd += trade.usd_value;
  }

  const openPositions = positions.filter((position) => position.status === 'open');

  // Only positions whose entry we actually observed can be marked. Summing the
  // rest as zero would quietly report a smaller loss than reality.
  const markable = openPositions.filter((position) => position.unrealized_pnl_usd !== null);
  const unrealizedUsd = markable.reduce((sum, p) => sum + (p.unrealized_pnl_usd ?? 0), 0);
  const markedCostBasis = markable.reduce((sum, p) => sum + p.cost_basis_usd, 0);

  const cards: Stat[] = [
    { label: 'Portfolio', value: formatUsd(currentValue || whale.portfolio_value_usd) },
    {
      label: 'Unrealised P&L',
      value: markable.length
        ? `${unrealizedUsd >= 0 ? '+' : ''}${formatUsd(unrealizedUsd)}`
        : '—',
      tone: markable.length === 0 ? undefined : unrealizedUsd >= 0 ? 'bull' : 'bear',
      // Three different reasons this can be blank, and they are not the same
      // thing to a reader: no data at all, nothing currently held, or holdings
      // whose entry we never witnessed. Saying "no known entry" for a wallet we
      // have simply never seen trade reads as a broken feature.
      hint: markable.length
        ? `${markable.length}/${openPositions.length} open positions priced${
            markedCostBasis > 0
              ? ` · ${unrealizedUsd >= 0 ? '+' : ''}${((unrealizedUsd / markedCostBasis) * 100).toFixed(0)}%`
              : ''
          }`
        : positions.length === 0
          ? 'no trades ingested for this wallet yet'
          : openPositions.length === 0
            ? `${positions.length} closed position${positions.length === 1 ? '' : 's'}, nothing held`
            : 'holdings opened before tracking began',
    },
    {
      label: 'Meme exposure',
      value: formatPercent(
        currentValue > 0 ? memeValue / currentValue : whale.meme_exposure_pct,
        0
      ).replace('+', ''),
      hint: formatUsd(memeValue || whale.meme_value_usd),
    },
    { label: 'Whale score', value: whale.score.toFixed(1), hint: whale.tier },
    { label: 'Trades 30d', value: String(whale.trade_count_30d) },
    { label: 'Largest trade', value: formatUsd(whale.max_trade_size_usd) },
    {
      label: 'Net flow',
      value: `${boughtUsd - soldUsd >= 0 ? '+' : ''}${formatUsd(boughtUsd - soldUsd)}`,
      tone: boughtUsd - soldUsd >= 0 ? 'bull' : 'bear',
      hint: `${formatUsd(boughtUsd)} in · ${formatUsd(soldUsd)} out`,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-xl font-semibold tracking-tight">
              {whale.label ?? shortenAddress(address, 8)}
            </h1>
            <span
              className={cn(
                'rounded-md border px-2 py-0.5 text-xs font-medium capitalize',
                tierColor(whale.tier)
              )}
            >
              {whale.tier}
            </span>
            {!whale.is_tracked && <Badge variant="outline">untracked</Badge>}
          </div>

          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{address}</p>

          <p className="mt-1 text-xs text-muted-foreground">
            Discovered via {whale.discovery_source ?? 'unknown'} · first seen{' '}
            {timeAgo(whale.first_seen_at)} · last active {timeAgo(whale.last_active_at)} · last
            synced {timeAgo(whale.last_synced_at)}
          </p>
        </div>

        <a
          href={EXPLORERS.account(address)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
        >
          Solscan <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      <StatCards stats={cards} />

      {archetypes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">How this wallet behaves</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ArchetypePanel archetypes={archetypes} />
            <p className="border-t border-border pt-3 text-[11px] text-muted-foreground">
              Descriptions of measured behaviour over the activity we have recorded, not claims
              about who controls this wallet. Tags marked provisional rest on a small sample and can
              change.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Portfolio value</CardTitle>
          </CardHeader>
          <CardContent>
            <PortfolioTimeline data={timeline} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Allocation</CardTitle>
          </CardHeader>
          <CardContent>
            <PortfolioAllocation holdings={portfolio} />
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="trades">
        <TabsList>
          <TabsTrigger value="trades">Trades ({trades.count})</TabsTrigger>
          <TabsTrigger value="positions">Positions ({positions.length})</TabsTrigger>
          <TabsTrigger value="holdings">Holdings ({portfolio.length})</TabsTrigger>
          <TabsTrigger value="alerts">Alerts ({alerts.count})</TabsTrigger>
        </TabsList>

        <TabsContent value="trades">
          <TradeHistory
            trades={trades.rows}
            emptyMessage="No meme-token trades recorded for this wallet yet."
          />
        </TabsContent>

        <TabsContent value="positions">
          <PositionsTable
            positions={positions}
            emptyMessage="No positions reconstructed yet. Run /api/cron/rebuild-positions to build them from stored trades."
          />
        </TabsContent>

        <TabsContent value="holdings">
          <div className="surface overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Token</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                  <TableHead>Type</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {portfolio.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                      No snapshot yet. Run <code>/api/cron/portfolios</code> to capture holdings.
                    </TableCell>
                  </TableRow>
                )}
                {[...pricedHoldings, ...unpricedHoldings].map((holding) => {
                  const noPrice = holding.price_usd === null;
                  return (
                    <TableRow key={holding.token_mint} className={noPrice ? 'opacity-70' : ''}>
                      <TableCell>
                        <Link
                          href={`/tokens/${holding.token_mint}`}
                          className="text-sm font-medium hover:text-primary"
                        >
                          {holding.token_symbol ?? shortenAddress(holding.token_mint)}
                        </Link>
                      </TableCell>
                      <TableCell className="tabular text-right text-xs">
                        {formatAmount(holding.amount)}
                      </TableCell>
                      <TableCell className="tabular text-right text-xs text-muted-foreground">
                        {noPrice ? 'no feed' : formatPrice(holding.price_usd)}
                      </TableCell>
                      <TableCell className="tabular text-right font-medium">
                        {noPrice ? (
                          <span className="text-muted-foreground">unpriced</span>
                        ) : (
                          formatUsd(holding.usd_value)
                        )}
                      </TableCell>
                      <TableCell className="tabular text-right text-xs text-muted-foreground">
                        {holding.pct_of_portfolio && !noPrice
                          ? `${(holding.pct_of_portfolio * 100).toFixed(1)}%`
                          : '—'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={holding.is_meme ? 'default' : 'outline'}>
                          {holding.is_meme ? 'meme' : noPrice ? 'unpriced' : 'other'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {unpricedHoldings.length > 0 && (
              <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                {pricedHoldings.length} priced · {unpricedHoldings.length} unpriced. Unpriced
                positions are held on-chain but no price feed covers them, so they are excluded
                from portfolio value rather than counted as $0.
              </p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="alerts">
          <AlertList initial={alerts.rows} live={false} limit={25} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
