import { ExternalLink } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EXPLORERS } from '@/lib/solana/constants';
import { cn, formatPercentPoints, formatPrice, formatUsd, shortenAddress } from '@/lib/utils';
import type { TokenLeaderboardRow } from '@/types';

/**
 * Meme token leaderboard, ranked by 24h net whale flow.
 *
 * Net flow — buys minus sells among tracked whales — is the column that
 * matters. Raw volume tells you a token is busy; net flow tells you which
 * direction the wallets with size are leaning.
 */
export function TokenLeaderboard({ rows }: { rows: TokenLeaderboardRow[] }) {
  return (
    <div className="surface overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Token</TableHead>
            <TableHead className="text-right">Price</TableHead>
            <TableHead className="text-right">24h</TableHead>
            <TableHead className="text-right">Net whale flow</TableHead>
            <TableHead className="text-right">Buys / Sells</TableHead>
            <TableHead className="text-right">Whales</TableHead>
            <TableHead className="text-right">New pos.</TableHead>
            <TableHead className="text-right">Liquidity</TableHead>
            <TableHead className="w-8" />
          </TableRow>
        </TableHeader>

        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                No tokens tracked yet. Run <code>/api/cron/tokens</code> to populate the universe.
              </TableCell>
            </TableRow>
          )}

          {rows.map((row) => {
            const inflow = row.net_flow_usd_24h > 0;
            return (
              <TableRow key={row.mint}>
                <TableCell>
                  <Link href={`/tokens/${row.mint}`} className="flex items-center gap-2 hover:text-primary">
                    <span className="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-[10px] font-semibold">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {row.logo_uri ? (
                        <img src={row.logo_uri} alt="" className="h-full w-full object-cover" />
                      ) : (
                        row.symbol.slice(0, 2)
                      )}
                    </span>
                    <span>
                      <span className="block text-sm font-medium">{row.symbol}</span>
                      <span className="block font-mono text-[10px] text-muted-foreground">
                        {shortenAddress(row.mint)}
                      </span>
                    </span>
                  </Link>
                </TableCell>

                <TableCell className="tabular text-right">{formatPrice(row.price_usd)}</TableCell>

                <TableCell
                  className={cn(
                    'tabular text-right',
                    (row.price_change_24h ?? 0) >= 0
                      ? 'text-[hsl(var(--bull))]'
                      : 'text-[hsl(var(--bear))]'
                  )}
                >
                  {formatPercentPoints(row.price_change_24h)}
                </TableCell>

                <TableCell
                  className={cn(
                    'tabular text-right font-semibold',
                    row.net_flow_usd_24h === 0
                      ? 'text-muted-foreground'
                      : inflow
                        ? 'text-[hsl(var(--bull))]'
                        : 'text-[hsl(var(--bear))]'
                  )}
                >
                  {row.net_flow_usd_24h === 0
                    ? '—'
                    : `${inflow ? '+' : ''}${formatUsd(row.net_flow_usd_24h)}`}
                </TableCell>

                <TableCell className="tabular text-right text-xs">
                  <span className="text-[hsl(var(--bull))]">{formatUsd(row.whale_buy_usd_24h)}</span>
                  <span className="text-muted-foreground"> / </span>
                  <span className="text-[hsl(var(--bear))]">{formatUsd(row.whale_sell_usd_24h)}</span>
                </TableCell>

                <TableCell className="tabular text-right">{row.whale_count_24h}</TableCell>

                <TableCell className="text-right">
                  {row.new_positions_24h > 0 ? (
                    <Badge variant="default">{row.new_positions_24h}</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>

                <TableCell className="tabular text-right text-muted-foreground">
                  {formatUsd(row.liquidity_usd)}
                </TableCell>

                <TableCell>
                  <a
                    href={EXPLORERS.birdeye(row.mint)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={`Open ${row.symbol} on Birdeye`}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
