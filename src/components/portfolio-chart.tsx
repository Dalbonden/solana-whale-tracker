'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { formatUsd } from '@/lib/utils';
import type { PortfolioHolding } from '@/types';

/**
 * Chart colours are pulled from the theme tokens so the charts stay consistent
 * with the rest of the UI in both themes rather than hard-coding hex values.
 */
const SERIES = {
  total: 'hsl(173 80% 45%)',
  meme: 'hsl(280 70% 60%)',
};

const SLICE_COLORS = [
  'hsl(173 80% 45%)',
  'hsl(280 70% 60%)',
  'hsl(35 90% 58%)',
  'hsl(210 85% 60%)',
  'hsl(152 65% 48%)',
  'hsl(340 75% 60%)',
  'hsl(255 70% 65%)',
  'hsl(45 85% 55%)',
];

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 shadow-lg">
      {label !== undefined && (
        <p className="mb-1 text-[11px] text-muted-foreground">
          {new Date(label).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </p>
      )}
      {payload.map((entry) => (
        <p key={entry.name} className="tabular flex items-center gap-2 text-xs">
          <span className="h-2 w-2 rounded-full" style={{ background: entry.color }} />
          <span className="text-muted-foreground">{entry.name}</span>
          <span className="ml-auto font-medium">{formatUsd(entry.value)}</span>
        </p>
      ))}
    </div>
  );
}

/** Portfolio value over time, with meme exposure stacked underneath the total. */
export function PortfolioTimeline({
  data,
}: {
  data: Array<{ snapshot_at: string; total_usd: number; meme_usd: number }>;
}) {
  if (data.length < 2) {
    return (
      <div className="flex h-[240px] items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
        Not enough snapshots yet — the timeline appears after two portfolio runs.
      </div>
    );
  }

  const points = data.map((point) => ({
    time: new Date(point.snapshot_at).getTime(),
    total: point.total_usd,
    meme: point.meme_usd,
  }));

  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="fill-total" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={SERIES.total} stopOpacity={0.35} />
            <stop offset="100%" stopColor={SERIES.total} stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="fill-meme" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={SERIES.meme} stopOpacity={0.35} />
            <stop offset="100%" stopColor={SERIES.meme} stopOpacity={0.02} />
          </linearGradient>
        </defs>

        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis
          dataKey="time"
          type="number"
          domain={['dataMin', 'dataMax']}
          tickFormatter={(value) =>
            new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          }
          stroke="hsl(var(--muted-foreground))"
          fontSize={11}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tickFormatter={(value) => formatUsd(value)}
          stroke="hsl(var(--muted-foreground))"
          fontSize={11}
          tickLine={false}
          axisLine={false}
          width={58}
        />
        <Tooltip content={<ChartTooltip />} />
        <Area
          type="monotone"
          dataKey="total"
          name="Total"
          stroke={SERIES.total}
          fill="url(#fill-total)"
          strokeWidth={2}
        />
        <Area
          type="monotone"
          dataKey="meme"
          name="Meme"
          stroke={SERIES.meme}
          fill="url(#fill-meme)"
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Current allocation. Small positions are folded into "Other" to stay legible. */
export function PortfolioAllocation({ holdings }: { holdings: PortfolioHolding[] }) {
  if (!holdings.length) {
    return (
      <div className="flex h-[240px] items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
        No priced holdings in the latest snapshot.
      </div>
    );
  }

  const sorted = [...holdings].sort((a, b) => b.usd_value - a.usd_value);
  const top = sorted.slice(0, 7);
  const rest = sorted.slice(7);
  const restTotal = rest.reduce((sum, holding) => sum + holding.usd_value, 0);

  const slices = [
    ...top.map((holding) => ({
      name: holding.token_symbol ?? holding.token_mint.slice(0, 6),
      value: holding.usd_value,
    })),
    ...(restTotal > 0 ? [{ name: `Other (${rest.length})`, value: restTotal }] : []),
  ];

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <ResponsiveContainer width="100%" height={220} className="max-w-[220px]">
        <PieChart>
          <Pie
            data={slices}
            dataKey="value"
            nameKey="name"
            innerRadius={54}
            outerRadius={88}
            paddingAngle={2}
            stroke="hsl(var(--background))"
            strokeWidth={2}
          >
            {slices.map((slice, index) => (
              <Cell key={slice.name} fill={SLICE_COLORS[index % SLICE_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip />} />
        </PieChart>
      </ResponsiveContainer>

      <ul className="flex-1 space-y-1.5">
        {slices.map((slice, index) => {
          const total = slices.reduce((sum, entry) => sum + entry.value, 0);
          return (
            <li key={slice.name} className="flex items-center gap-2 text-xs">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: SLICE_COLORS[index % SLICE_COLORS.length] }}
              />
              <span className="truncate">{slice.name}</span>
              <span className="tabular ml-auto text-muted-foreground">
                {((slice.value / total) * 100).toFixed(1)}%
              </span>
              <span className="tabular w-20 text-right font-medium">{formatUsd(slice.value)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
