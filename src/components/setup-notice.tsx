import { AlertTriangle } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Shown when a page cannot load because the deployment is not configured.
 *
 * Without this, a missing Supabase key looks identical to "no whales found",
 * which is the single most confusing failure mode for a data-driven dashboard.
 */
export function SetupNotice({ error }: { error: string }) {
  const isConfig =
    error.includes('not configured') || error.includes('Missing required environment variable');

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <AlertTriangle className="h-4 w-4 text-amber-400" />
        <CardTitle className="text-amber-200">
          {isConfig ? 'Setup incomplete' : 'Could not load data'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p className="font-mono text-xs text-amber-200/90">{error}</p>
        {isConfig && (
          <ol className="list-decimal space-y-1 pl-4">
            <li>
              Copy <code className="text-foreground">.env.example</code> to{' '}
              <code className="text-foreground">.env.local</code> and fill in the keys.
            </li>
            <li>
              Apply <code className="text-foreground">supabase/schema.sql</code> and{' '}
              <code className="text-foreground">supabase/seed.sql</code> in the Supabase SQL editor.
            </li>
            <li>
              Trigger a first discovery run:{' '}
              <code className="text-foreground">
                curl -H &quot;Authorization: Bearer $CRON_SECRET&quot; localhost:3000/api/cron/discover
              </code>
            </li>
          </ol>
        )}
        <p>
          Check <code className="text-foreground">/api/health</code> for a full integration report.
        </p>
      </CardContent>
    </Card>
  );
}

/** Neutral empty state for a configured-but-not-yet-populated dataset. */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="max-w-md text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
