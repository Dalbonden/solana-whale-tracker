import { ExternalLink } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PriceChart } from '@/components/price-chart';
import { TokenRiskPanel } from '@/components/token-risk-panel';
import { SetupNotice } from '@/components/setup-notice';
import { StatCards, type Stat } from '@/components/stat-cards';
import { TradeHistory } from '@/components/trade-history';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getToken, listTrades } from '@/lib/db/repositories';
import { EXPLORERS } from '@/lib/solana/constants';
import {
  formatPercentPoints,
  formatPrice,
  formatUsd,
  isValidSolanaAddress,
  shortenAddress,
  timeAgo,
} from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: { mint: string } }): Promise<Metadata> {
  try {
    const token = await getToken(params.mint);
    return { title: token?.symbol ?? shortenAddress(params.mint) };
  } catch {
    return { title: 'Token' };
  }
}

export default async function TokenPage({ params }: { params: { mint: string } }) {
  const mint = params.mint;
  if (!isValidSolanaAddress(mint)) notFound();

  let data;
  try {
    const token = await getToken(mint);
    if (!token) notFound();

    const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const trades = await listTrades({ mint, since, pageSize: 150 });
    data = { token, trades };
  } catch (error) {
    if ((error as Error).message === 'NEXT_NOT_FOUND') throw error;
    return <SetupNotice error={(error as Error).message} />;
  }

  const { token, trades } = data;

  // Per-whale net position across the visible window: who is actually
  // accumulating this name versus who is distributing into it.
  const byWhale = new Map<string, { buy: number; sell: number; last: string }>();
  for (const trade of trades.rows) {
    const entry = byWhale.get(trade.whale_address) ?? { buy: 0, sell: 0, last: trade.block_time };
    if (trade.side === 'buy') entry.buy += trade.usd_value;
    else entry.sell += trade.usd_value;
    if (trade.block_time > entry.last) entry.last = trade.block_time;
    byWhale.set(trade.whale_address, entry);
  }

  const ranked = [...byWhale.entries()]
    .map(([address, entry]) => ({ address, ...entry, net: entry.buy - entry.sell }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
    .slice(0, 12);

  const buyUsd = trades.rows.reduce((sum, t) => sum + (t.side === 'buy' ? t.usd_value : 0), 0);
  const sellUsd = trades.rows.reduce((sum, t) => sum + (t.side === 'sell' ? t.usd_value : 0), 0);

  const cards: Stat[] = [
    { label: 'Price', value: formatPrice(token.price_usd) },
    {
      label: '24h change',
      value: formatPercentPoints(token.price_change_24h),
      tone: (token.price_change_24h ?? 0) >= 0 ? 'bull' : 'bear',
    },
    { label: 'Market cap', value: formatUsd(token.market_cap_usd) },
    { label: 'Liquidity', value: formatUsd(token.liquidity_usd) },
    {
      label: 'Whale net flow 7d',
      value: `${buyUsd - sellUsd >= 0 ? '+' : ''}${formatUsd(buyUsd - sellUsd)}`,
      tone: buyUsd - sellUsd >= 0 ? 'bull' : 'bear',
    },
    { label: 'Whales active 7d', value: String(byWhale.size) },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-xs font-semibold">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {token.logo_uri ? (
              <img src={token.logo_uri} alt="" className="h-full w-full object-cover" />
            ) : (
              token.symbol.slice(0, 3)
            )}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{token.symbol}</h1>
              {token.is_core && <Badge variant="secondary">core</Badge>}
              {token.pumpfun_graduated && <Badge variant="default">pump.fun graduate</Badge>}
              <Badge variant="outline">{token.source}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">{token.name ?? '—'}</p>
            <p className="break-all font-mono text-[11px] text-muted-foreground">{mint}</p>
          </div>
        </div>

        <div className="flex gap-2">
          <a
            href={EXPLORERS.birdeye(mint)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
          >
            Birdeye <ExternalLink className="h-3 w-3" />
          </a>
          <a
            href={EXPLORERS.token(mint)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
          >
            Solscan <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>

      <StatCards stats={cards} />

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Price with whale trades</CardTitle>
          </CardHeader>
          <CardContent>
            <PriceChart mint={mint} symbol={token.symbol} />
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Holder concentration &amp; rug risk</CardTitle>
          </CardHeader>
          <CardContent>
            <TokenRiskPanel mint={mint} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Whale positioning (7d)</CardTitle>
          </CardHeader>
          <CardContent>
            {ranked.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                No tracked whale has traded this token in the last 7 days.
              </p>
            ) : (
              <ul className="space-y-2">
                {ranked.map((entry) => (
                  <li key={entry.address} className="flex items-center gap-2 text-xs">
                    <Link
                      href={`/whales/${entry.address}`}
                      className="font-mono hover:text-primary"
                    >
                      {shortenAddress(entry.address)}
                    </Link>
                    <span className="text-muted-foreground">{timeAgo(entry.last)}</span>
                    <span
                      className="tabular ml-auto font-medium"
                      style={{
                        color:
                          entry.net >= 0 ? 'hsl(var(--bull))' : 'hsl(var(--bear))',
                      }}
                    >
                      {entry.net >= 0 ? '+' : ''}
                      {formatUsd(entry.net)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Whale trades (7d)</h2>
        <TradeHistory
          trades={trades.rows}
          showWhale
          emptyMessage="No whale trades recorded for this token in the last 7 days."
        />
      </section>
    </div>
  );
}
