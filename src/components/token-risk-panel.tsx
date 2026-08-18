'use client';

import { AlertTriangle, Flame, Lock, ShieldCheck, Snowflake, Users } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EXPLORERS } from '@/lib/solana/constants';
import { cn, formatUsd, shortenAddress } from '@/lib/utils';

interface Holder {
  owner: string | null;
  pctOfSupply: number;
  label: string;
  discretionary: boolean;
  kind: string;
}

interface RiskPayload {
  symbol: string | null;
  riskScore: number;
  riskLevel: 'low' | 'moderate' | 'elevated' | 'high' | 'critical' | 'unknown';
  top1Pct: number;
  top10Pct: number;
  rawTop10Pct: number;
  excludedPct: number;
  canMintMore: boolean;
  canFreeze: boolean;
  liquidityUsd: number | null;
  liquidityRatio: number | null;
  holders: Holder[];
  reasons: string[];
  creator: {
    address: string | null;
    note: string | null;
    holdsPctOfSupply: number | null;
    stillHolding: boolean | null;
  };
  error?: string;
}

const LEVEL_STYLES: Record<string, string> = {
  low: 'text-[hsl(var(--bull))] border-[hsl(var(--bull)/0.3)] bg-[hsl(var(--bull)/0.1)]',
  moderate: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  elevated: 'text-orange-400 border-orange-500/30 bg-orange-500/10',
  high: 'text-rose-400 border-rose-500/30 bg-rose-500/10',
  critical: 'text-rose-300 border-rose-500/50 bg-rose-500/20',
  unknown: 'text-muted-foreground border-border bg-muted/40',
};

/**
 * Holder-concentration and rug-vector panel.
 *
 * Deliberately framed as risk, never as a forecast. It answers "how badly could
 * this hurt me if a large holder sells" — not "will this pump". The distinction
 * is kept visible in the copy because a risk score read as a buy signal is
 * worse than no score at all.
 */
export function TokenRiskPanel({ mint }: { mint: string }) {
  const [data, setData] = useState<RiskPayload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/tokens/${mint}/risk`)
      .then((r) => r.json())
      .then((payload) => !cancelled && setData(payload))
      .catch((e) => !cancelled && setData({ error: e.message } as RiskPayload))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [mint]);

  if (loading) return <Skeleton className="h-64 w-full" />;
  if (!data || data.error) {
    return (
      <p className="py-8 text-center text-xs text-muted-foreground">
        Could not analyse holders{data?.error ? `: ${data.error}` : '.'}
      </p>
    );
  }

  const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'grid h-14 w-14 shrink-0 place-items-center rounded-lg border text-lg font-semibold tabular',
            LEVEL_STYLES[data.riskLevel]
          )}
        >
          {Math.round(data.riskScore)}
        </div>
        <div>
          <p className="text-sm font-semibold capitalize">{data.riskLevel} risk</p>
          <p className="text-[11px] text-muted-foreground">
            Ownership risk out of 100. Measures exposure to a large holder selling — not a
            prediction that it will happen.
          </p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Flag
          ok={!data.canMintMore}
          icon={data.canMintMore ? AlertTriangle : ShieldCheck}
          label={data.canMintMore ? 'Mint authority ACTIVE' : 'Mint authority revoked'}
          detail={data.canMintMore ? 'More supply can be printed at any time' : 'Supply is fixed'}
        />
        <Flag
          ok={!data.canFreeze}
          icon={data.canFreeze ? Snowflake : ShieldCheck}
          label={data.canFreeze ? 'Freeze authority ACTIVE' : 'Freeze authority revoked'}
          detail={data.canFreeze ? 'Your balance can be frozen' : 'Balances cannot be frozen'}
        />
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <Metric label="Top holder" value={pct(data.top1Pct)} />
        <Metric label="Top 10" value={pct(data.top10Pct)} />
        <Metric label="Liquidity" value={formatUsd(data.liquidityUsd)} />
      </div>

      {data.excludedPct > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Raw top-10 is {pct(data.rawTop10Pct)}; {pct(data.excludedPct)} sits in AMM pools and burn
          addresses, which cannot choose to sell and is excluded above.
        </p>
      )}

      {/* Creator */}
      <div className="rounded-md border border-border p-3">
        <p className="mb-1 flex items-center gap-1.5 text-xs font-medium">
          <Lock className="h-3.5 w-3.5" /> Creator wallet
        </p>
        {data.creator.address ? (
          <p className="text-[11px] text-muted-foreground">
            <a
              href={EXPLORERS.account(data.creator.address)}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono hover:text-foreground"
            >
              {shortenAddress(data.creator.address, 6)}
            </a>{' '}
            — holds {pct(data.creator.holdsPctOfSupply)} of supply
            {data.creator.stillHolding === false && ' (not among the largest holders)'}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">{data.creator.note}</p>
        )}
      </div>

      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
          <Users className="h-3.5 w-3.5" /> Largest holders
        </p>
        <ul className="space-y-1">
          {data.holders.slice(0, 8).map((h, i) => (
            <li key={h.owner ?? i} className="flex items-center gap-2 text-[11px]">
              <span className="w-4 text-muted-foreground">{i + 1}</span>
              <span className="font-mono">{shortenAddress(h.owner, 4)}</span>
              {!h.discretionary && (
                <Badge variant="outline" className="text-[9px]">
                  {h.label}
                </Badge>
              )}
              <span className="tabular ml-auto font-medium">{(h.pctOfSupply * 100).toFixed(2)}%</span>
            </li>
          ))}
        </ul>
      </div>

      <ul className="space-y-1 border-t border-border pt-3">
        {data.reasons.map((r) => (
          <li key={r} className="flex gap-1.5 text-[11px] text-muted-foreground">
            <Flame className="mt-0.5 h-3 w-3 shrink-0" />
            {r}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Flag({
  ok,
  icon: Icon,
  label,
  detail,
}: {
  ok: boolean;
  icon: typeof Flame;
  label: string;
  detail: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md border p-2.5',
        ok ? 'border-border' : 'border-rose-500/30 bg-rose-500/5'
      )}
    >
      <Icon
        className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', ok ? 'text-[hsl(var(--bull))]' : 'text-rose-400')}
      />
      <div>
        <p className="text-[11px] font-medium">{label}</p>
        <p className="text-[10px] text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="tabular mt-0.5 text-sm font-semibold">{value}</p>
    </div>
  );
}
