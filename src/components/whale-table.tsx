'use client';

import { ArrowUpDown, Search } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { ArchetypeBadges, type ArchetypeView } from '@/components/archetype-badges';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn, formatPercent, formatUsd, shortenAddress, tierColor, timeAgo } from '@/lib/utils';
import type { Whale } from '@/types';

type SortKey = 'score' | 'portfolio_value_usd' | 'meme_value_usd' | 'trade_count_30d' | 'last_active_at';

const COLUMNS: Array<{ key: SortKey; label: string; align?: 'right' }> = [
  { key: 'score', label: 'Score', align: 'right' },
  { key: 'portfolio_value_usd', label: 'Portfolio', align: 'right' },
  { key: 'meme_value_usd', label: 'Meme value', align: 'right' },
  { key: 'trade_count_30d', label: 'Trades 30d', align: 'right' },
  { key: 'last_active_at', label: 'Last active', align: 'right' },
];

export function WhaleTable({
  whales,
  showSearch = true,
  archetypes,
}: {
  whales: Whale[];
  showSearch?: boolean;
  /** Behaviour tags keyed by address. Absent when the caller did not load them. */
  archetypes?: Record<string, ArchetypeView[]>;
}) {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('score');

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? whales.filter(
          (whale) =>
            whale.address.toLowerCase().includes(needle) ||
            whale.label?.toLowerCase().includes(needle)
        )
      : whales;

    return [...filtered].sort((a, b) => {
      if (sortKey === 'last_active_at') {
        return (
          new Date(b.last_active_at ?? 0).getTime() - new Date(a.last_active_at ?? 0).getTime()
        );
      }
      return (b[sortKey] as number) - (a[sortKey] as number);
    });
  }, [whales, query, sortKey]);

  return (
    <div className="space-y-3">
      {showSearch && (
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by address or label…"
            className="pl-9"
            aria-label="Filter whales"
          />
        </div>
      )}

      <div className="surface overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Wallet</TableHead>
              <TableHead>Tier</TableHead>
              {COLUMNS.map((column) => (
                <TableHead key={column.key} className={column.align === 'right' ? 'text-right' : ''}>
                  <button
                    type="button"
                    onClick={() => setSortKey(column.key)}
                    className={cn(
                      'inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-foreground',
                      sortKey === column.key && 'text-foreground'
                    )}
                  >
                    {column.label}
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                </TableHead>
              ))}
              <TableHead className="text-right">Meme exp.</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  No whales match this filter.
                </TableCell>
              </TableRow>
            )}

            {rows.map((whale) => (
              <TableRow key={whale.address}>
                <TableCell>
                  <Link
                    href={`/whales/${whale.address}`}
                    className="font-mono text-xs hover:text-primary"
                  >
                    {whale.label ?? shortenAddress(whale.address, 6)}
                  </Link>
                  {whale.label && (
                    <p className="font-mono text-[10px] text-muted-foreground">
                      {shortenAddress(whale.address, 4)}
                    </p>
                  )}
                  {archetypes?.[whale.address]?.length ? (
                    <ArchetypeBadges
                      archetypes={archetypes[whale.address]}
                      limit={3}
                      className="mt-1"
                    />
                  ) : null}
                </TableCell>

                <TableCell>
                  <span
                    className={cn(
                      'inline-flex rounded-md border px-2 py-0.5 text-[11px] font-medium capitalize',
                      tierColor(whale.tier)
                    )}
                  >
                    {whale.tier}
                  </span>
                </TableCell>

                <TableCell className="tabular text-right font-medium">
                  {whale.score.toFixed(1)}
                </TableCell>
                <TableCell className="tabular text-right">
                  {formatUsd(whale.portfolio_value_usd)}
                </TableCell>
                <TableCell className="tabular text-right">
                  {formatUsd(whale.meme_value_usd)}
                </TableCell>
                <TableCell className="tabular text-right">{whale.trade_count_30d}</TableCell>
                <TableCell className="text-right text-xs text-muted-foreground">
                  {timeAgo(whale.last_active_at)}
                </TableCell>
                <TableCell className="text-right">
                  <Badge variant={whale.meme_exposure_pct >= 0.5 ? 'default' : 'outline'}>
                    {formatPercent(whale.meme_exposure_pct, 0).replace('+', '')}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
