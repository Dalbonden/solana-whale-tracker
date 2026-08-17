import { ExternalLink } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AlertList } from '@/components/alert-list';
import { PortfolioAllocation, PortfolioTimeline } from '@/components/portfolio-chart';
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
import {
  getCurrentPortfolio,
  getPortfolioTimeline,
  getWhale,
  listAlerts,
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

    const [portfolio, timeline, trades, alerts] = await Promise.all([
      getCurrentPortfolio(address),
      getPortfolioTimeline(address, 30),
      listTrades({ whale: address, pageSize: 100 }),
      listAlerts({ whale: address, pageSize: 25 }),
    ]);

    data = { whale, portfolio, timeline, trades, alerts };
  } catch (error) {
    if ((error as Error).message === 'NEXT_NOT_FOUND') throw error;
    return <SetupNotice error={(error as Error).message} />;
  }

  const { whale, portfolio, timeline, trades, alerts } = data;

  const memeHoldings = portfolio.filter((holding) => holding.is_meme);
  const currentValue = portfolio.reduce((sum, holding) => sum + holding.usd_value, 0);
  const memeValue = memeHoldings.reduce((sum, holding) => sum + holding.usd_value, 0);

  let boughtUsd = 0;
  let soldUsd = 0;
  for (const trade of trades.rows) {
    if (trade.side === 'buy') boughtUsd += trade.usd_value;
    else soldUsd += trade.usd_value;
  }

  const cards: Stat[] = [
    { label: 'Portfolio', value: formatUsd(currentValue || whale.portfolio_value_usd) },
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
          <TabsTrigger value="holdings">Holdings ({portfolio.length})</TabsTrigger>
          <TabsTrigger value="alerts">Alerts ({alerts.count})</TabsTrigger>
        </TabsList>

        <TabsContent value="trades">
          <TradeHistory
            trades={trades.rows}
            emptyMessage="No meme-token trades recorded for this wallet yet."
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
                {portfolio.map((holding) => (
                  <TableRow key={holding.token_mint}>
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
                      {formatPrice(holding.price_usd)}
                    </TableCell>
                    <TableCell className="tabular text-right font-medium">
                      {formatUsd(holding.usd_value)}
                    </TableCell>
                    <TableCell className="tabular text-right text-xs text-muted-foreground">
                      {holding.pct_of_portfolio
                        ? `${(holding.pct_of_portfolio * 100).toFixed(1)}%`
                        : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={holding.is_meme ? 'default' : 'outline'}>
                        {holding.is_meme ? 'meme' : 'other'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="alerts">
          <AlertList initial={alerts.rows} live={false} limit={25} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
