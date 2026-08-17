'use client';

import { ArrowDownRight, ArrowUpRight, ExternalLink, Radio } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';

import { useLiveFeed } from '@/hooks/use-live-feed';
import { EXPLORERS } from '@/lib/solana/constants';
import { cn, formatAmount, formatUsd, shortenAddress, timeAgo } from '@/lib/utils';
import type { WhaleTrade } from '@/types';

import { Badge } from './ui/badge';

const STATE_LABEL: Record<string, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  error: 'Offline',
};

/**
 * Real-time trade feed.
 *
 * Server-rendered trades come in as `initial`; the SSE hook prepends anything
 * that lands afterwards. Merging on `id` means an overlap between the initial
 * page and the first streamed batch cannot produce duplicate rows.
 */
export function ActivityFeed({
  initial,
  limit = 40,
  className,
}: {
  initial: WhaleTrade[];
  limit?: number;
  className?: string;
}) {
  const { trades: streamed, state, lastEventAt } = useLiveFeed({ maxItems: limit });

  const rows = useMemo(() => {
    const seen = new Set(streamed.map((trade) => trade.id));
    return [...streamed, ...initial.filter((trade) => !seen.has(trade.id))].slice(0, limit);
  }, [streamed, initial, limit]);

  return (
    <div className={cn('surface flex flex-col', className)}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Live activity</h2>
          <Badge variant={state === 'live' ? 'bull' : 'outline'} className="gap-1">
            <Radio className="h-3 w-3" />
            {STATE_LABEL[state]}
          </Badge>
        </div>
        {lastEventAt && (
          <span className="text-[11px] text-muted-foreground">
            updated {timeAgo(lastEventAt)}
          </span>
        )}
      </div>

      <div className="max-h-[560px] divide-y divide-border overflow-y-auto">
        {rows.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            No whale trades yet. Once discovery and sync have run, activity appears here in real time.
          </p>
        )}

        {rows.map((trade) => {
          const isBuy = trade.side === 'buy';
          return (
            <article
              key={trade.id}
              className="flex items-start gap-3 px-4 py-3 animate-slide-in hover:bg-muted/30"
            >
              <span
                className={cn(
                  'mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md',
                  isBuy
                    ? 'bg-[hsl(var(--bull)/0.15)] text-[hsl(var(--bull))]'
                    : 'bg-[hsl(var(--bear)/0.15)] text-[hsl(var(--bear))]'
                )}
              >
                {isBuy ? (
                  <ArrowUpRight className="h-4 w-4" />
                ) : (
                  <ArrowDownRight className="h-4 w-4" />
                )}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Link
                    href={`/whales/${trade.whale_address}`}
                    className="font-mono text-xs text-foreground hover:text-primary"
                  >
                    {shortenAddress(trade.whale_address)}
                  </Link>
                  <span className="text-xs text-muted-foreground">{isBuy ? 'bought' : 'sold'}</span>
                  <span className="text-sm font-medium">
                    {trade.token_symbol ?? shortenAddress(trade.token_mint)}
                  </span>
                  {trade.is_new_position && (
                    <Badge variant="default" className="text-[10px]">
                      new position
                    </Badge>
                  )}
                  {trade.is_full_exit && (
                    <Badge variant="bear" className="text-[10px]">
                      full exit
                    </Badge>
                  )}
                </div>

                <p className="tabular mt-0.5 text-[11px] text-muted-foreground">
                  {formatAmount(trade.token_amount)}{' '}
                  {trade.token_symbol ?? ''} · {trade.venue} · {timeAgo(trade.block_time)}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={cn(
                    'tabular text-sm font-semibold',
                    isBuy ? 'text-[hsl(var(--bull))]' : 'text-[hsl(var(--bear))]'
                  )}
                >
                  {formatUsd(trade.usd_value)}
                </span>
                <a
                  href={EXPLORERS.tx(trade.signature)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground transition-colors hover:text-foreground"
                  aria-label="View transaction on Solscan"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
