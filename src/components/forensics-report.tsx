'use client';

import {
  AlertTriangle,
  ExternalLink,
  Info,
  Link2,
  Search,
  ShieldCheck,
  Timer,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EXPLORERS } from '@/lib/solana/constants';
import { cn, formatAmount, formatUsd, isValidSolanaAddress, shortenAddress } from '@/lib/utils';

type Level = 'low' | 'medium' | 'high';

interface Signal {
  code: string;
  detail: string;
  weight: number;
}

interface Suspect {
  address: string;
  secondsAfterLaunch: number;
  firstBuyAt: string;
  tokensBought: number;
  usdBought: number | null;
  shareOfEarlyVolume: number;
  buyCount: number;
  sellCount: number;
  stillHolding: boolean | null;
  pctOfSupply: number | null;
  linkedToDeployer: boolean;
  clusterId: number | null;
  score: number;
  level: Level;
  signals: Signal[];
}

interface Cluster {
  id: number;
  members: string[];
  atSecondsAfterLaunch: number;
  combinedTokens: number;
  combinedShareOfEarlyVolume: number;
  membersLinkedToDeployer: number;
}

interface Report {
  mint: string;
  symbol: string | null;
  launchAt: string | null;
  deployer: {
    address: string | null;
    note: string | null;
    stillHolding: boolean | null;
    pctOfSupply: number | null;
    counterpartiesScanned: number;
  };
  mintAuthorityActive: boolean;
  freezeAuthorityActive: boolean;
  earlyTradesSampled: number;
  distinctEarlyBuyers: number;
  suspects: Suspect[];
  clusters: Cluster[];
  summary: string[];
  limitations: string[];
  error?: string;
}

const LEVEL_STYLES: Record<Level, string> = {
  high: 'text-rose-300 border-rose-500/50 bg-rose-500/15',
  medium: 'text-orange-400 border-orange-500/30 bg-orange-500/10',
  low: 'text-muted-foreground border-border bg-muted/40',
};

function elapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

export function ForensicsReport({ initialMint = '' }: { initialMint?: string }) {
  const [input, setInput] = useState(initialMint);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(mint: string) {
    const trimmed = mint.trim();
    if (!isValidSolanaAddress(trimmed)) {
      setError('That does not look like a Solana token address.');
      setReport(null);
      return;
    }
    setLoading(true);
    setError(null);
    setReport(null);
    try {
      const response = await fetch(`/api/tokens/${trimmed}/forensics`);
      const payload = await response.json();
      if (!response.ok || payload.error) {
        setError(payload.error ?? `Request failed (${response.status}).`);
      } else {
        setReport(payload);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(input);
        }}
        className="flex flex-col gap-2 sm:flex-row"
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Token mint address, e.g. ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82"
          className="font-mono text-xs"
          spellCheck={false}
        />
        <Button type="submit" disabled={loading || !input.trim()}>
          <Search className="mr-1.5 h-3.5 w-3.5" />
          {loading ? 'Analysing…' : 'Analyse launch'}
        </Button>
      </form>

      {/*
        Stated before any result is shown, not buried under it. The whole point
        of this page is patterns worth a second look — presenting it as a verdict
        would be both wrong and far more harmful than showing nothing.
      */}
      <div className="flex gap-2 rounded-md border border-border bg-muted/30 p-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          This describes publicly visible trading behaviour around a token&apos;s launch. It does
          not identify people, establish coordination, or indicate that anything improper happened.
          Buying quickly is not wrongdoing — automated snipers enter every launch and score here
          exactly like a wallet with prior knowledge. Treat every result as a question, never an
          answer.
        </p>
      </div>

      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {error && (
        <div className="flex gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
          <p className="text-xs text-rose-200">{error}</p>
        </div>
      )}

      {report && <Result report={report} />}
    </div>
  );
}

function Result({ report }: { report: Report }) {
  const high = report.suspects.filter((s) => s.level === 'high').length;

  return (
    <div className="space-y-6">
      {/* --- summary ------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {report.symbol ?? shortenAddress(report.mint, 6)}
            {high > 0 && (
              <Badge variant="bear" className="text-[10px]">
                {high} to inspect
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-4">
            <Metric label="First trade" value={report.launchAt ? new Date(report.launchAt).toLocaleString() : '—'} />
            <Metric label="Trades sampled" value={String(report.earlyTradesSampled)} />
            <Metric label="Early buyers" value={String(report.distinctEarlyBuyers)} />
            <Metric label="Cohorts" value={String(report.clusters.length)} />
          </div>

          <ul className="space-y-1.5">
            {report.summary.map((line) => (
              <li key={line} className="flex gap-2 text-xs text-muted-foreground">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
                {line}
              </li>
            ))}
          </ul>

          <div className="grid gap-2 sm:grid-cols-2">
            <Flag
              ok={!report.mintAuthorityActive}
              label={report.mintAuthorityActive ? 'Mint authority ACTIVE' : 'Mint authority revoked'}
              detail={
                report.mintAuthorityActive
                  ? 'More supply can be printed at any time'
                  : 'Supply is fixed'
              }
            />
            <Flag
              ok={!report.freezeAuthorityActive}
              label={report.freezeAuthorityActive ? 'Freeze authority ACTIVE' : 'Freeze authority revoked'}
              detail={
                report.freezeAuthorityActive ? 'Balances can be frozen' : 'Balances cannot be frozen'
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* --- deployer ----------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Deployer</CardTitle>
        </CardHeader>
        <CardContent>
          {report.deployer.address ? (
            <div className="space-y-1.5 text-xs">
              <a
                href={EXPLORERS.account(report.deployer.address)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono hover:text-primary"
              >
                {shortenAddress(report.deployer.address, 6)}
                <ExternalLink className="h-3 w-3 opacity-60" />
              </a>
              <p className="text-muted-foreground">
                {report.deployer.stillHolding
                  ? `Still among the largest holders${
                      report.deployer.pctOfSupply !== null
                        ? ` (${(report.deployer.pctOfSupply * 100).toFixed(2)}% of tracked supply)`
                        : ''
                    }.`
                  : 'Not among the largest holders — the wallet may have distributed or sold down.'}
              </p>
              <p className="text-muted-foreground">
                {report.deployer.counterpartiesScanned} direct counterparties found while scanning
                this wallet&apos;s recent transactions.
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{report.deployer.note}</p>
          )}
        </CardContent>
      </Card>

      {/* --- wallets ------------------------------------------------------ */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Wallets ranked by pattern strength</h2>
        {report.suspects.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            No wallet activity could be reconstructed for this launch.
          </p>
        ) : (
          <div className="space-y-2">
            {report.suspects.map((s, i) => (
              <SuspectRow key={s.address} suspect={s} rank={i + 1} />
            ))}
          </div>
        )}
      </section>

      {/* --- clusters ----------------------------------------------------- */}
      {report.clusters.length > 0 && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Users className="h-3.5 w-3.5" /> Synchronised cohorts
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Groups of three or more wallets whose first buy landed within seconds of each other.
            Weak on its own — a launch draws a crowd — but meaningful when the same wallets also
            show up above.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {report.clusters.map((c) => (
              <div key={c.id} className="rounded-md border border-border p-3 text-xs">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="font-medium">Cohort {c.id}</span>
                  <span className="tabular text-muted-foreground">
                    +{elapsed(c.atSecondsAfterLaunch)} after launch
                  </span>
                </div>
                <p className="text-muted-foreground">
                  {c.members.length} wallets · {(c.combinedShareOfEarlyVolume * 100).toFixed(1)}% of
                  sampled opening volume
                  {c.membersLinkedToDeployer > 0 &&
                    ` · ${c.membersLinkedToDeployer} with a direct deployer transfer`}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {c.members.slice(0, 8).map((m) => (
                    <a
                      key={m}
                      href={EXPLORERS.account(m)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] hover:text-primary"
                    >
                      {shortenAddress(m, 3)}
                    </a>
                  ))}
                  {c.members.length > 8 && (
                    <span className="px-1 py-0.5 text-[10px] text-muted-foreground">
                      +{c.members.length - 8}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* --- limitations -------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">What this analysis cannot tell you</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1.5">
            {report.limitations.map((l) => (
              <li key={l} className="flex gap-2 text-[11px] text-muted-foreground">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
                {l}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function SuspectRow({ suspect, rank }: { suspect: Suspect; rank: number }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="surface overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-accent/40"
      >
        <span className="w-5 shrink-0 text-xs text-muted-foreground">{rank}</span>

        <span
          className={cn(
            'grid h-9 w-9 shrink-0 place-items-center rounded-md border text-xs font-semibold tabular',
            LEVEL_STYLES[suspect.level]
          )}
        >
          {Math.round(suspect.score)}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-xs">{shortenAddress(suspect.address, 5)}</span>
            <Badge variant="outline" className="text-[9px] capitalize">
              {suspect.level}
            </Badge>
            {suspect.linkedToDeployer && (
              <Badge variant="bear" className="gap-1 text-[9px]">
                <Link2 className="h-2.5 w-2.5" /> deployer transfer
              </Badge>
            )}
            {suspect.clusterId !== null && (
              <Badge variant="secondary" className="text-[9px]">
                cohort {suspect.clusterId}
              </Badge>
            )}
          </span>
          <span className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Timer className="h-3 w-3" />+{elapsed(suspect.secondsAfterLaunch)}
            </span>
            <span>{formatAmount(suspect.tokensBought)} tokens</span>
            {suspect.usdBought !== null && <span>{formatUsd(suspect.usdBought)}</span>}
            <span>{(suspect.shareOfEarlyVolume * 100).toFixed(1)}% of opening volume</span>
            <span>
              {suspect.stillHolding === null
                ? 'holdings unknown'
                : suspect.stillHolding
                  ? 'still holding'
                  : 'not a large holder now'}
            </span>
          </span>
        </span>

        <span className="shrink-0 text-[10px] text-muted-foreground">{open ? 'hide' : 'why'}</span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-border p-3">
          <ul className="space-y-1.5">
            {suspect.signals.map((signal) => (
              <li key={signal.code} className="flex gap-2 text-[11px]">
                <span className="tabular mt-px w-6 shrink-0 text-muted-foreground">
                  +{signal.weight}
                </span>
                <span className="text-muted-foreground">{signal.detail}</span>
              </li>
            ))}
            {suspect.signals.length === 0 && (
              <li className="text-[11px] text-muted-foreground">
                Nothing notable — an ordinary early buy.
              </li>
            )}
          </ul>
          <div className="flex flex-wrap gap-3 pt-1 text-[11px]">
            <a
              href={EXPLORERS.account(suspect.address)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            >
              Solscan <ExternalLink className="h-3 w-3" />
            </a>
            <Link
              href={`/whales/${suspect.address}`}
              className="text-muted-foreground hover:text-foreground"
            >
              Open in tracker
            </Link>
            <span className="text-muted-foreground">
              {suspect.buyCount} buys · {suspect.sellCount} sells in sample
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="tabular mt-0.5 truncate text-sm font-semibold">{value}</p>
    </div>
  );
}

function Flag({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md border p-2.5',
        ok ? 'border-border' : 'border-rose-500/30 bg-rose-500/5'
      )}
    >
      {ok ? (
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--bull))]" />
      ) : (
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" />
      )}
      <div>
        <p className="text-[11px] font-medium">{label}</p>
        <p className="text-[10px] text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}
