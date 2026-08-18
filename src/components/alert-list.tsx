'use client';

import {
  ArrowLeftRight,
  ArrowUpRight,
  ExternalLink,
  Flame,
  LogOut,
  Sparkles,
  TrendingDown,
  Users,
  Waves,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';

import { Badge } from '@/components/ui/badge';
import { useLiveFeed } from '@/hooks/use-live-feed';
import { EXPLORERS } from '@/lib/solana/constants';
import { alertTypeLabel, cn, formatUsd, severityColor, shortenAddress, timeAgo } from '@/lib/utils';
import type { Alert, AlertType } from '@/types';

const ICONS: Record<AlertType, typeof Flame> = {
  new_position: Sparkles,
  large_buy: ArrowUpRight,
  large_sell: TrendingDown,
  full_exit: LogOut,
  rotation: ArrowLeftRight,
  cluster_buy: Users,
  pumpfun_snipe: Flame,
  whale_discovered: Waves,
};

/**
 * Alert stream. Server-rendered alerts arrive as `initial`; when `live` is set
 * the SSE hook prepends new ones as they are generated.
 */
export function AlertList({
  initial,
  live = true,
  limit = 60,
  filterLabel,
}: {
  initial: Alert[];
  live?: boolean;
  limit?: number;
  /** Active type filter, so an empty result explains itself accurately. */
  filterLabel?: string;
}) {
  const { alerts: streamed } = useLiveFeed({ maxItems: limit, enabled: live });

  const rows = useMemo(() => {
    const seen = new Set(streamed.map((alert) => alert.id));
    return [...streamed, ...initial.filter((alert) => !seen.has(alert.id))].slice(0, limit);
  }, [streamed, initial, limit]);

  if (!rows.length) {
    /*
     * A filtered view with no matches is not the same problem as having no
     * alerts at all. Telling someone to go check discovery and sync when they
     * have simply selected a category that has not fired yet sends them
     * debugging something that is not broken.
     */
    return (
      <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border py-12 text-center">
        <p className="text-sm font-medium">
          {filterLabel ? `No ${filterLabel.toLowerCase()} alerts yet` : 'No alerts yet'}
        </p>
        <p className="max-w-md text-xs text-muted-foreground">
          {filterLabel
            ? `Other alert types may still have fired — clear the filter to see everything.`
            : 'Alerts are generated as tracked whales trade. If this stays empty, check that discovery has found whales and that the sync job or Helius webhook is running.'}
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {rows.map((alert) => {
        const Icon = ICONS[alert.type] ?? Sparkles;
        return (
          <li
            key={alert.id}
            className={cn(
              'surface flex items-start gap-3 p-4 animate-slide-in',
              alert.severity === 'critical' && 'border-rose-500/25'
            )}
          >
            <span
              className={cn(
                'grid h-8 w-8 shrink-0 place-items-center rounded-md border',
                severityColor(alert.severity)
              )}
            >
              <Icon className="h-4 w-4" />
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium">{alert.title}</h3>
                <Badge variant="outline" className="capitalize">
                  {alertTypeLabel(alert.type)}
                </Badge>
                {alert.usd_value ? (
                  <span className="tabular text-xs font-medium text-muted-foreground">
                    {formatUsd(alert.usd_value)}
                  </span>
                ) : null}
              </div>

              <p className="mt-1 text-xs text-muted-foreground">{alert.message}</p>

              <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                <span>{timeAgo(alert.created_at)}</span>

                {alert.whale_address && (
                  <Link
                    href={`/whales/${alert.whale_address}`}
                    className="font-mono hover:text-foreground"
                  >
                    {shortenAddress(alert.whale_address)}
                  </Link>
                )}

                {alert.token_mint && (
                  <Link href={`/tokens/${alert.token_mint}`} className="hover:text-foreground">
                    {alert.token_symbol ?? shortenAddress(alert.token_mint)}
                  </Link>
                )}

                {alert.signature && (
                  <a
                    href={EXPLORERS.tx(alert.signature)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    transaction <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
