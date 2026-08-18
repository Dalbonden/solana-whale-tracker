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
import { cn, formatAmount, formatDateTime, formatPrice, formatUsd, shortenAddress } from '@/lib/utils';
import type { WhaleTrade } from '@/types';

export function TradeHistory({
  trades,
  showWhale = false,
  emptyMessage = 'No trades recorded yet.',
}: {
  trades: WhaleTrade[];
  showWhale?: boolean;
  emptyMessage?: string;
}) {
  return (
    <div className="surface overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Time</TableHead>
            {showWhale && <TableHead>Wallet</TableHead>}
            <TableHead>Side</TableHead>
            <TableHead>Token</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">Price</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead className="text-right">P&amp;L</TableHead>
            <TableHead>Venue</TableHead>
            <TableHead className="w-8" />
          </TableRow>
        </TableHeader>

        <TableBody>
          {trades.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={showWhale ? 10 : 9}
                className="py-10 text-center text-sm text-muted-foreground"
              >
                {emptyMessage}
              </TableCell>
            </TableRow>
          )}

          {trades.map((trade) => {
            const isBuy = trade.side === 'buy';
            return (
              <TableRow key={trade.id}>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDateTime(trade.block_time)}
                </TableCell>

                {showWhale && (
                  <TableCell>
                    <Link
                      href={`/whales/${trade.whale_address}`}
                      className="font-mono text-xs hover:text-primary"
                    >
                      {shortenAddress(trade.whale_address)}
                    </Link>
                  </TableCell>
                )}

                <TableCell>
                  <Badge variant={isBuy ? 'bull' : 'bear'}>{isBuy ? 'Buy' : 'Sell'}</Badge>
                </TableCell>

                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Link
                      href={`/tokens/${trade.token_mint}`}
                      className="text-sm font-medium hover:text-primary"
                    >
                      {trade.token_symbol ?? shortenAddress(trade.token_mint)}
                    </Link>
                    {trade.is_new_position && (
                      <Badge variant="default" className="text-[10px]">
                        new
                      </Badge>
                    )}
                    {trade.is_full_exit && (
                      <Badge variant="bear" className="text-[10px]">
                        exit
                      </Badge>
                    )}
                  </div>
                </TableCell>

                <TableCell className="tabular text-right text-xs">
                  {formatAmount(trade.token_amount)}
                </TableCell>

                <TableCell className="tabular text-right text-xs text-muted-foreground">
                  {formatPrice(trade.price_usd)}
                </TableCell>

                <TableCell
                  className={cn(
                    'tabular text-right font-medium',
                    isBuy ? 'text-[hsl(var(--bull))]' : 'text-[hsl(var(--bear))]'
                  )}
                >
                  {formatUsd(trade.usd_value)}
                </TableCell>

                <TableCell className="tabular text-right text-xs">
                  {trade.realized_pnl_usd === null || trade.realized_pnl_usd === undefined ? (
                    <span
                      className="text-muted-foreground"
                      title={
                        isBuy
                          ? 'P&L is realised on the sell, not the buy'
                          : 'This position was opened before tracking began, so its cost basis is unknown'
                      }
                    >
                      —
                    </span>
                  ) : (
                    <span
                      className={
                        trade.realized_pnl_usd >= 0
                          ? 'text-[hsl(var(--bull))]'
                          : 'text-[hsl(var(--bear))]'
                      }
                    >
                      {trade.realized_pnl_usd >= 0 ? '+' : ''}
                      {formatUsd(trade.realized_pnl_usd)}
                      {trade.realized_pnl_pct !== null && trade.realized_pnl_pct !== undefined && (
                        <span className="ml-1 opacity-70">
                          ({trade.realized_pnl_pct >= 0 ? '+' : ''}
                          {(trade.realized_pnl_pct * 100).toFixed(0)}%)
                        </span>
                      )}
                    </span>
                  )}
                </TableCell>

                <TableCell className="text-xs capitalize text-muted-foreground">
                  {trade.venue}
                </TableCell>

                <TableCell>
                  <a
                    href={EXPLORERS.tx(trade.signature)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="View transaction"
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
