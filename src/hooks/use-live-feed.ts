'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Alert, WhaleTrade } from '@/types';

type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'error';

interface LiveFeedOptions {
  /** Cap on retained items; the feed runs indefinitely, memory must not. */
  maxItems?: number;
  enabled?: boolean;
}

/**
 * Subscribes to `/api/stream` and keeps a rolling window of the newest trades
 * and alerts.
 *
 * `EventSource` reconnects on its own when the serverless function reaches its
 * duration limit, replaying `Last-Event-ID` so the server resumes from the same
 * cursor. That means a reconnect is invisible to the user and loses no events —
 * we only surface it as a brief "reconnecting" indicator.
 */
export function useLiveFeed({ maxItems = 100, enabled = true }: LiveFeedOptions = {}) {
  const [trades, setTrades] = useState<WhaleTrade[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [lastEventAt, setLastEventAt] = useState<Date | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const merge = useCallback(
    <T extends { id: string }>(previous: T[], incoming: T[]): T[] => {
      if (!incoming.length) return previous;
      const seen = new Set(previous.map((item) => item.id));
      const fresh = incoming.filter((item) => !seen.has(item.id));
      if (!fresh.length) return previous;
      return [...fresh, ...previous].slice(0, maxItems);
    },
    [maxItems]
  );

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const source = new EventSource('/api/stream');
    sourceRef.current = source;

    source.addEventListener('connected', () => setState('live'));

    source.addEventListener('trades', (event) => {
      try {
        const incoming = JSON.parse((event as MessageEvent).data) as WhaleTrade[];
        setTrades((previous) => merge(previous, incoming));
        setLastEventAt(new Date());
      } catch {
        // A malformed frame should not kill the stream.
      }
    });

    source.addEventListener('alerts', (event) => {
      try {
        const incoming = JSON.parse((event as MessageEvent).data) as Alert[];
        setAlerts((previous) => merge(previous, incoming));
        setLastEventAt(new Date());
      } catch {
        // ignore
      }
    });

    source.addEventListener('reconnect', () => setState('reconnecting'));

    source.onerror = () => {
      // EventSource retries automatically; CLOSED means it gave up.
      setState(source.readyState === EventSource.CLOSED ? 'error' : 'reconnecting');
    };

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [enabled, merge]);

  return { trades, alerts, state, lastEventAt };
}
