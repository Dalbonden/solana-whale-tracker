import Link from 'next/link';

import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        That wallet or token is not being tracked. Whales appear here once discovery has scored them;
        tokens appear once they are in the meme universe.
      </p>
      <div className="flex gap-2">
        <Button asChild variant="outline" size="sm">
          <Link href="/whales">Browse whales</Link>
        </Button>
        <Button asChild size="sm">
          <Link href="/">Dashboard</Link>
        </Button>
      </div>
    </div>
  );
}
