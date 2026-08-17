import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatUsd(value: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (opts.compact !== false) {
    if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  }

  if (abs < 0.01 && abs > 0) return `${sign}$${abs.toPrecision(2)}`;
  return `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0';
  if (value < 0.000001) return `$${value.toExponential(2)}`;
  if (value < 1) return `$${value.toPrecision(4)}`;
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

export function formatAmount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  if (abs < 0.001 && abs > 0) return value.toExponential(2);
  return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`;
}

/** Birdeye already returns percent-scaled values; this avoids a double ×100. */
export function formatPercentPoints(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

export function shortenAddress(address: string | null | undefined, chars = 4): string {
  if (!address) return '—';
  if (address.length <= chars * 2 + 1) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

export function timeAgo(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const date = typeof input === 'string' ? new Date(input) : input;
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (Number.isNaN(seconds)) return '—';
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function formatDateTime(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const date = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Cheap structural check — avoids a base58 decode on every request. */
export function isValidSolanaAddress(value: string): boolean {
  return BASE58.test(value);
}

export function tierColor(tier: string): string {
  switch (tier) {
    case 'kraken':
      return 'text-fuchsia-400 border-fuchsia-500/30 bg-fuchsia-500/10';
    case 'whale':
      return 'text-sky-400 border-sky-500/30 bg-sky-500/10';
    case 'dolphin':
      return 'text-teal-400 border-teal-500/30 bg-teal-500/10';
    default:
      return 'text-muted-foreground border-border bg-muted/40';
  }
}

export function severityColor(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'text-rose-400 border-rose-500/30 bg-rose-500/10';
    case 'warning':
      return 'text-amber-400 border-amber-500/30 bg-amber-500/10';
    default:
      return 'text-sky-400 border-sky-500/30 bg-sky-500/10';
  }
}

export function alertTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    new_position: 'New position',
    large_buy: 'Large buy',
    large_sell: 'Large sell',
    full_exit: 'Full exit',
    rotation: 'Rotation',
    cluster_buy: 'Whale cluster',
    pumpfun_snipe: 'Pump.fun snipe',
    whale_discovered: 'New whale',
  };
  return labels[type] ?? type;
}
