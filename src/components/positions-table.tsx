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
import type { PositionView } from '@/lib/core/positions';
import { cn, formatAmount, formatPrice, formatUsd, shortenAddress } from '@/lib/utils';

function formatHold(hours: number): string {
  if (hours < 1) return `${Math.max(Math.round(hours * 60), 1)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  const days = hours / 24;
  if (days < 60) return `${days.toFixed(1)}d`;
  return `${(days / 30.44).toFixed(1)}mo`;
}

/** Share of the whale's book, as a bar. Reading a number is slower. */
function ConvictionBar({ pct }: { pct: number | null }) {
  if (pct === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  // 25% of a book is an enormous single-name bet, so the bar saturates there
  // rather than at 100% — otherwise every real position renders as a sliver.
  const filled = Math.min(pct / 0.25, 1);
  return (
    <div className="flex items-center justify-end gap-1.5">
      <span className="tabular text-xs">{(pct * 100).toFixed(1)}%</span>
      <span className="h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${Math.max(filled * 100, 3)}%` }}
        />
      </span>
    </div>
  );
}

function Pnl({ usd, pct }: { usd: number | null; pct: number | null }) {
  if (usd === null) {
    return (
      <span
        className="text-muted-foreground"
        title="Entry predates tracking or no price feed covers this token, so the basis is unknown"
      >
        —
      </span>
    );
  }
  const up = usd >= 0;
  return (
    <span className={up ? 'text-[hsl(var(--bull))]' : 'text-[hsl(var(--bear))]'}>
      {up ? '+' : ''}
      {formatUsd(usd)}
      {pct !== null && (
        <span className="ml-1 opacity-70">
          ({up ? '+' : ''}
          {(pct * 100).toFixed(0)}%)
        </span>
      )}
    </span>
  );
}

/**
 * Open and closed position cycles.
 *
 * Deliberately separate from the Holdings tab: holdings answer "what is in the
 * wallet right now", which a snapshot can do. This answers "what did it cost,
 * how long have they held it, and are they up" — which only the trade history
 * can, and only for positions we watched them open.
 */
export function PositionsTable({
  positions,
  emptyMessage = 'No positions reconstructed yet.',
}: {
  positions: PositionView[];
  emptyMessage?: string;
}) {
  const unknownBasis = positions.filter((p) => !p.basis_complete).length;

  return (
    <div className="surface overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Token</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Held</TableHead>
            <TableHead className="text-right">Avg entry</TableHead>
            <TableHead className="text-right">Now</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead className="text-right">Unrealised</TableHead>
            <TableHead className="text-right">Realised</TableHead>
            <TableHead className="text-right">Conviction</TableHead>
            <TableHead className="text-right">Hold</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {positions.length === 0 && (
            <TableRow>
              <TableCell colSpan={10} className="py-10 text-center text-sm text-muted-foreground">
                {emptyMessage}
              </TableCell>
            </TableRow>
          )}

          {positions.map((position) => {
            const closed = position.status === 'closed';
            return (
              <TableRow key={position.id} className={closed ? 'opacity-60' : ''}>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Link
                      href={`/tokens/${position.token_mint}`}
                      className="text-sm font-medium hover:text-primary"
                    >
                      {position.token_symbol ?? shortenAddress(position.token_mint)}
                    </Link>
                    {!position.basis_complete && (
                      <Badge
                        variant="outline"
                        className="text-[9px]"
                        title="First activity we saw was a sell, so the entry price is unknown"
                      >
                        no basis
                      </Badge>
                    )}
                  </div>
                </TableCell>

                <TableCell>
                  <Badge variant={closed ? 'outline' : 'default'} className="text-[10px]">
                    {closed ? 'closed' : 'open'}
                  </Badge>
                </TableCell>

                <TableCell className="tabular text-right text-xs">
                  {closed ? '—' : formatAmount(position.amount)}
                </TableCell>

                <TableCell className="tabular text-right text-xs text-muted-foreground">
                  {position.avg_entry_price === null ? '—' : formatPrice(position.avg_entry_price)}
                </TableCell>

                <TableCell className="tabular text-right text-xs text-muted-foreground">
                  {position.price_usd === null ? 'no feed' : formatPrice(position.price_usd)}
                </TableCell>

                <TableCell className="tabular text-right font-medium">
                  {closed ? (
                    <span className="text-muted-foreground">—</span>
                  ) : position.market_value_usd === null ? (
                    <span className="text-muted-foreground">unpriced</span>
                  ) : (
                    formatUsd(position.market_value_usd)
                  )}
                </TableCell>

                <TableCell className="tabular text-right text-xs">
                  {closed ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <Pnl usd={position.unrealized_pnl_usd} pct={position.unrealized_pnl_pct} />
                  )}
                </TableCell>

                <TableCell className="tabular text-right text-xs">
                  {position.sell_count === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <Pnl
                      usd={position.basis_complete ? position.realized_pnl_usd : null}
                      pct={null}
                    />
                  )}
                </TableCell>

                <TableCell className="text-right">
                  {closed ? (
                    <span className="text-xs text-muted-foreground">—</span>
                  ) : (
                    <ConvictionBar pct={position.conviction_pct} />
                  )}
                </TableCell>

                <TableCell
                  className={cn('tabular text-right text-xs text-muted-foreground')}
                  title={`Opened ${new Date(position.opened_at).toLocaleString()}`}
                >
                  {formatHold(position.hold_hours)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {unknownBasis > 0 && (
        <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          {unknownBasis} position{unknownBasis === 1 ? '' : 's'} opened before tracking began. We
          only ever saw the sell side, so entry price and P&amp;L are genuinely unknown and are left
          blank rather than estimated.
        </p>
      )}
    </div>
  );
}
