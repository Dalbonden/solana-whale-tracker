import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface Stat {
  label: string;
  value: string;
  hint?: string;
  icon?: LucideIcon;
  /** Colours the value: positive/negative flow, neutral otherwise. */
  tone?: 'neutral' | 'bull' | 'bear';
}

export function StatCards({ stats }: { stats: Stat[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {stats.map((stat) => {
        const Icon = stat.icon;
        return (
          <div key={stat.label} className="surface p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {stat.label}
              </p>
              {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
            </div>
            <p
              className={cn(
                'tabular mt-2 text-xl font-semibold tracking-tight',
                stat.tone === 'bull' && 'text-[hsl(var(--bull))]',
                stat.tone === 'bear' && 'text-[hsl(var(--bear))]'
              )}
            >
              {stat.value}
            </p>
            {stat.hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{stat.hint}</p>}
          </div>
        );
      })}
    </div>
  );
}
