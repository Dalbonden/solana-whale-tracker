'use client';

import { Loader2, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isValidSolanaAddress } from '@/lib/utils';

/**
 * Adds a mint to the tracked universe.
 *
 * The API applies the meme classifier first; when it refuses, the reason is
 * shown along with the option to add anyway — which is the right default, since
 * the classifier is a heuristic and the person typing the mint usually knows
 * more than it does.
 */
export function AddTokenForm() {
  const router = useRouter();
  const [mint, setMint] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving'>('idle');
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [canForce, setCanForce] = useState(false);

  async function submit(force: boolean) {
    if (!isValidSolanaAddress(mint.trim())) {
      setMessage({ kind: 'error', text: 'That does not look like a Solana mint address.' });
      return;
    }

    setStatus('saving');
    setMessage(null);

    try {
      const response = await fetch('/api/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mint: mint.trim(), force }),
      });
      const payload = await response.json();

      if (!response.ok) {
        setMessage({ kind: 'error', text: payload.error ?? 'Could not add token.' });
        setCanForce(response.status === 422);
        return;
      }

      setMessage({
        kind: 'success',
        text: `Added ${payload.token?.symbol ?? mint.slice(0, 6)} to the tracked universe.`,
      });
      setMint('');
      setCanForce(false);
      router.refresh();
    } catch (error) {
      setMessage({ kind: 'error', text: (error as Error).message });
    } finally {
      setStatus('idle');
    }
  }

  return (
    <div className="w-full max-w-md space-y-2">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <Input
          value={mint}
          onChange={(event) => setMint(event.target.value)}
          placeholder="Add a meme token by mint address…"
          className="font-mono text-xs"
          aria-label="Token mint address"
        />
        <Button type="submit" size="sm" disabled={status === 'saving' || !mint.trim()}>
          {status === 'saving' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          Add
        </Button>
      </form>

      {message && (
        <p
          className={
            message.kind === 'error'
              ? 'text-[11px] text-[hsl(var(--bear))]'
              : 'text-[11px] text-[hsl(var(--bull))]'
          }
        >
          {message.text}
          {canForce && (
            <button
              type="button"
              onClick={() => void submit(true)}
              className="ml-2 underline underline-offset-2 hover:text-foreground"
            >
              Add anyway
            </button>
          )}
        </p>
      )}
    </div>
  );
}
