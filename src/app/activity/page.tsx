import type { Metadata } from 'next';
import Link from 'next/link';

import { ActivityFeed } from '@/components/activity-feed';
import { SetupNotice } from '@/components/setup-notice';
import { StatCards, type Stat } from '@/components/stat-cards';
import { TradeHistory } from '@/components/trade-history';
import { listTrades } from '@/lib/db/repositories';
import { cn, formatUsd } from '@/lib/utils';

export const metadata: Metadata = { title: 'Activity' };
export const dynamic = 'force-dynamic';

const SIZE_FILTERS = [
  { value: 0, label: 'All' },
  { value: 10_000, label: '$10K+' },
  { value: 50_000, label: '$50K+' },
  { value: 250_000, label: '$250K+' },
];

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: { minUsd?: string; side?: string };
}) {
  const minUsd = Number(searchParams.minUsd) || 0;
  const side = searchParams.side === 'buy' || searchParams.side === 'sell' ? searchParams.side : undefined;

  let data;
  try {
    const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
    const [feed, window24h] = await Promise.all([
      listTrades({ minUsd: minUsd || undefined, side, pageSize: 150 }),
      listTrades({ since: since24h, pageSize: 500 }),
    ]);
    data = { feed, window24h };
  } catch (error) {
    return (
      <div className="space-y-6">
        <Header />
        <SetupNotice error={(error as Error).message} />
      </div>
    );
  }

  const { feed, window24h } = data;

  const buyUsd = window24h.rows.reduce((sum, t) => sum + (t.side === 'buy' ? t.usd_value : 0), 0);
  const sellUsd = window24h.rows.reduce((sum, t) => sum + (t.side === 'sell' ? t.usd_value : 0), 0);
  const wallets = new Set(window24h.rows.map((t) => t.whale_address)).size;
  const tokens = new Set(window24h.rows.map((t) => t.token_mint)).size;

  const cards: Stat[] = [
    { label: 'Trades 24h', value: String(window24h.rows.length) },
    { label: 'Buys', value: formatUsd(buyUsd), tone: 'bull' },
    { label: 'Sells', value: formatUsd(sellUsd), tone: 'bear' },
    {
      label: 'Net',
      value: `${buyUsd - sellUsd >= 0 ? '+' : ''}${formatUsd(buyUsd - sellUsd)}`,
      tone: buyUsd - sellUsd >= 0 ? 'bull' : 'bear',
    },
    { label: 'Active wallets', value: String(wallets) },
    { label: 'Tokens touched', value: String(tokens) },
  ];

  const buildHref = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged = { minUsd: minUsd ? String(minUsd) : undefined, side, ...patch };
    for (const [key, value] of Object.entries(merged)) if (value) params.set(key, value);
    const query = params.toString();
    return query ? `/activity?${query}` : '/activity';
  };

  return (
    <div className="space-y-6">
      <Header />
      <StatCards stats={cards} />

      <div className="grid gap-6 xl:grid-cols-[1fr_400px]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1">
              {SIZE_FILTERS.map((filter) => (
                <Link
                  key={filter.value}
                  href={buildHref({ minUsd: filter.value ? String(filter.value) : undefined })}
                  className={cn(
                    'rounded-md border px-3 py-1 text-xs transition-colors',
                    minUsd === filter.value
                      ? 'border-border bg-secondary text-foreground'
                      : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                >
                  {filter.label}
                </Link>
              ))}
            </div>

            <div className="flex gap-1">
              {(['buy', 'sell'] as const).map((option) => (
                <Link
                  key={option}
                  href={buildHref({ side: side === option ? undefined : option })}
                  className={cn(
                    'rounded-md border px-3 py-1 text-xs capitalize transition-colors',
                    side === option
                      ? 'border-border bg-secondary text-foreground'
                      : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                >
                  {option}s only
                </Link>
              ))}
            </div>
          </div>

          <TradeHistory
            trades={feed.rows}
            showWhale
            emptyMessage="No trades match these filters."
          />
        </div>

        <ActivityFeed initial={feed.rows.slice(0, 40)} limit={40} />
      </div>
    </div>
  );
}

function Header() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
      <p className="text-sm text-muted-foreground">
        Every meme-token trade made by a tracked whale, newest first.
      </p>
    </div>
  );
}
