import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { config } from '@/lib/config';

/**
 * Server-side Supabase client using the service role key.
 *
 * RLS is enabled with no anon policies (see supabase/schema.sql), so all reads
 * and writes must go through this client — which means through server code.
 * Importing this module from a Client Component is a bug; the `server-only`
 * guard below turns that into a build error rather than a leaked key.
 */

let cached: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (cached) return cached;

  if (!config.supabase.enabled) {
    throw new Error(
      'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and ' +
        'SUPABASE_SERVICE_ROLE_KEY. See .env.example and README.md § Database.'
    );
  }

  cached = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'solana-whale-tracker' } },
  });

  return cached;
}

/** True when the database is reachable and the schema has been applied. */
export async function dbHealthy(): Promise<{ ok: boolean; error?: string }> {
  if (!config.supabase.enabled) return { ok: false, error: 'not configured' };
  try {
    const { error } = await db().from('meme_tokens').select('mint', { head: true, count: 'exact' });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
