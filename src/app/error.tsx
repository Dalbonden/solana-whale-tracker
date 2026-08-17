'use client';

import { useEffect } from 'react';

import { Button } from '@/components/ui/button';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Something broke</h1>
      <p className="max-w-lg font-mono text-xs text-muted-foreground">{error.message}</p>
      <p className="max-w-md text-sm text-muted-foreground">
        If this mentions a missing environment variable, check <code>/api/health</code> — it reports
        exactly which integrations are configured.
      </p>
      <Button onClick={reset} size="sm">
        Try again
      </Button>
    </div>
  );
}
