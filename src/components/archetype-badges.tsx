import {
  Activity,
  AlertTriangle,
  Bot,
  Crosshair,
  Gauge,
  HelpCircle,
  Layers,
  Target,
  TrendingDown,
  TrendingUp,
  Trophy,
  Wallet,
  Zap,
} from 'lucide-react';

import { cn } from '@/lib/utils';

export interface ArchetypeView {
  tag: string;
  label: string;
  kind: 'activity' | 'style' | 'skill' | 'risk' | 'position';
  detail: string;
  confidence: 'observed' | 'provisional';
}

const ICONS: Record<string, typeof Bot> = {
  smart_money: Trophy,
  losing: TrendingDown,
  gambler: Zap,
  concentrated: Target,
  diversified: Layers,
  bagholder: AlertTriangle,
  bot: Bot,
  sniper: Crosshair,
  flipper: Gauge,
  swing: Activity,
  holder: Wallet,
  size_player: Wallet,
  accumulating: TrendingUp,
  distributing: TrendingDown,
  unclassified: HelpCircle,
};

/**
 * Colour carries meaning, so it is assigned by what the tag says about the
 * wallet rather than by category. A green "smart money" next to a green
 * "holding losses" would make the palette decorative.
 */
const STYLES: Record<string, string> = {
  smart_money: 'border-[hsl(var(--bull)/0.4)] bg-[hsl(var(--bull)/0.12)] text-[hsl(var(--bull))]',
  accumulating: 'border-[hsl(var(--bull)/0.3)] bg-[hsl(var(--bull)/0.08)] text-[hsl(var(--bull))]',
  losing: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  bagholder: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  distributing: 'border-[hsl(var(--bear)/0.3)] bg-[hsl(var(--bear)/0.08)] text-[hsl(var(--bear))]',
  gambler: 'border-orange-500/40 bg-orange-500/10 text-orange-300',
  concentrated: 'border-orange-500/30 bg-orange-500/8 text-orange-300',
  sniper: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  bot: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
};

const DEFAULT_STYLE = 'border-border bg-muted/40 text-muted-foreground';

export function ArchetypeBadges({
  archetypes,
  limit,
  className,
}: {
  archetypes: ArchetypeView[];
  limit?: number;
  className?: string;
}) {
  const shown = limit ? archetypes.slice(0, limit) : archetypes;
  if (!shown.length) return null;

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {shown.map((a) => {
        const Icon = ICONS[a.tag] ?? HelpCircle;
        return (
          <span
            key={a.tag}
            // The evidence is the tooltip: a badge nobody can interrogate is
            // decoration, and this one is making a claim about someone.
            title={`${a.detail}${a.confidence === 'provisional' ? ' (provisional — thin sample)' : ''}`}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium leading-tight',
              STYLES[a.tag] ?? DEFAULT_STYLE,
              a.confidence === 'provisional' && 'opacity-70'
            )}
          >
            <Icon className="h-2.5 w-2.5" />
            {a.label}
            {a.confidence === 'provisional' && <span className="opacity-60">?</span>}
          </span>
        );
      })}
      {limit && archetypes.length > limit && (
        <span className="text-[10px] text-muted-foreground">+{archetypes.length - limit}</span>
      )}
    </div>
  );
}

/** Full breakdown with the reasoning visible, for the profile page. */
export function ArchetypePanel({ archetypes }: { archetypes: ArchetypeView[] }) {
  return (
    <ul className="space-y-2">
      {archetypes.map((a) => {
        const Icon = ICONS[a.tag] ?? HelpCircle;
        return (
          <li key={a.tag} className="flex gap-2.5">
            <span
              className={cn(
                'mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border',
                STYLES[a.tag] ?? DEFAULT_STYLE
              )}
            >
              <Icon className="h-3 w-3" />
            </span>
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-xs font-medium">
                {a.label}
                <span className="text-[10px] font-normal uppercase tracking-wider text-muted-foreground">
                  {a.kind}
                </span>
                {a.confidence === 'provisional' && (
                  <span
                    className="text-[10px] font-normal text-muted-foreground"
                    title="Sample is small enough that this could change"
                  >
                    · provisional
                  </span>
                )}
              </p>
              <p className="text-[11px] leading-relaxed text-muted-foreground">{a.detail}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
