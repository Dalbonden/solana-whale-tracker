'use client';

import { useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Skeleton } from '@/components/ui/skeleton';
import { formatPrice, formatUsd } from '@/lib/utils';

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Marker {
  time: number;
  side: 'buy' | 'sell';
  usdValue: number;
  price: number | null;
  whale: string;
  signature: string;
}

const INTERVALS = [
  { value: '5m', label: '5m', hours: 6 },
  { value: '15m', label: '15m', hours: 24 },
  { value: '1H', label: '1H', hours: 72 },
  { value: '4H', label: '4H', hours: 24 * 14 },
] as const;

/**
 * Birdeye price chart with whale trades overlaid as markers.
 *
 * The overlay is the point of this chart: seeing *where on the curve* the
 * tracked wallets bought or sold is what turns a price series into a read on
 * whether whales are buying strength or fading it.
 */
export function PriceChart({ mint, symbol }: { mint: string; symbol: string }) {
  const [interval, setInterval] = useState<(typeof INTERVALS)[number]>(INTERVALS[1]);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetch(`/api/tokens/${mint}/chart?interval=${interval.value}&hours=${interval.hours}`)
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        setCandles(payload.candles ?? []);
        setMarkers(payload.markers ?? []);
        setNote(payload.note ?? payload.error ?? null);
      })
      .catch((error) => {
        if (!cancelled) setNote(error.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [mint, interval]);

  if (loading) return <Skeleton className="h-[300px] w-full" />;

  if (!candles.length) {
    return (
      <div className="flex h-[300px] flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-xs text-muted-foreground">
        <p>No price data for {symbol}.</p>
        {note && <p className="max-w-md text-center">{note}</p>}
      </div>
    );
  }

  const first = candles[0].close;
  const last = candles[candles.length - 1].close;
  const up = last >= first;
  const color = up ? 'hsl(152 65% 48%)' : 'hsl(350 80% 62%)';

  // Only markers inside the visible window can be plotted.
  const from = candles[0].time;
  const to = candles[candles.length - 1].time;
  const visibleMarkers = markers.filter((marker) => marker.time >= from && marker.time <= to);

  /** Snaps a trade to the closest candle so the dot sits on the line. */
  const closestClose = (time: number): number => {
    let best = candles[0];
    for (const candle of candles) {
      if (Math.abs(candle.time - time) < Math.abs(best.time - time)) best = candle;
    }
    return best.close;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="tabular text-lg font-semibold">{formatPrice(last)}</span>
          <span
            className="tabular text-xs"
            style={{ color }}
          >
            {up ? '+' : ''}
            {(((last - first) / first) * 100).toFixed(2)}%
          </span>
        </div>

        <div className="flex gap-1">
          {INTERVALS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setInterval(option)}
              className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
                interval.value === option.value
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:bg-accent'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={300}>
        <AreaChart data={candles} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="fill-price" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>

          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis
            dataKey="time"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(value) =>
              new Date(value).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
            }
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            dataKey="close"
            domain={['auto', 'auto']}
            tickFormatter={(value) => formatPrice(value)}
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            width={72}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const candle = payload[0].payload as Candle;
              return (
                <div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-lg">
                  <p className="mb-1 text-[11px] text-muted-foreground">
                    {new Date(label as number).toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                  <p className="tabular">Close {formatPrice(candle.close)}</p>
                  <p className="tabular text-muted-foreground">
                    H {formatPrice(candle.high)} · L {formatPrice(candle.low)}
                  </p>
                </div>
              );
            }}
          />

          <Area
            type="monotone"
            dataKey="close"
            stroke={color}
            fill="url(#fill-price)"
            strokeWidth={2}
            isAnimationActive={false}
          />

          {visibleMarkers.map((marker) => (
            <ReferenceDot
              key={`${marker.signature}-${marker.whale}-${marker.side}`}
              x={marker.time}
              y={marker.price ?? closestClose(marker.time)}
              r={Math.min(4 + Math.log10(Math.max(marker.usdValue, 10)), 9)}
              fill={marker.side === 'buy' ? 'hsl(152 65% 48%)' : 'hsl(350 80% 62%)'}
              stroke="hsl(var(--background))"
              strokeWidth={1.5}
              isFront
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>

      {visibleMarkers.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {visibleMarkers.length} whale trades in view ·{' '}
          <span className="text-[hsl(var(--bull))]">
            {formatUsd(
              visibleMarkers
                .filter((marker) => marker.side === 'buy')
                .reduce((sum, marker) => sum + marker.usdValue, 0)
            )}{' '}
            bought
          </span>{' '}
          ·{' '}
          <span className="text-[hsl(var(--bear))]">
            {formatUsd(
              visibleMarkers
                .filter((marker) => marker.side === 'sell')
                .reduce((sum, marker) => sum + marker.usdValue, 0)
            )}{' '}
            sold
          </span>
        </p>
      )}
    </div>
  );
}
