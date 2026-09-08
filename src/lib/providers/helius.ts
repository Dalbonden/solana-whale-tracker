/**
 * Helius client — enhanced transactions, DAS asset balances, and webhooks.
 *
 * Helius is the only provider that returns pre-parsed token balance changes per
 * account, which is what makes swap attribution reliable without decoding every
 * AMM instruction layout ourselves.
 */

import { config, required } from '@/lib/config';
import { request, requestSoft } from './http';

/**
 * Standard RPC is labelled by whose account actually pays for it.
 *
 * The budget guard keys off the label prefix, so calling an Alchemy endpoint
 * `helius-rpc` would let an Alchemy outage mark Helius exhausted and silence
 * DAS — which is billed separately and may be perfectly healthy.
 */
function rpcLabel(): string {
  return config.solana.rpcIsSeparateFromHelius ? 'solana-rpc' : 'helius-rpc';
}

// --- Enhanced transaction shapes (subset we consume) ------------------------

export interface HeliusTokenBalanceChange {
  userAccount: string;
  tokenAccount: string;
  mint: string;
  rawTokenAmount: { tokenAmount: string; decimals: number };
}

export interface HeliusAccountData {
  account: string;
  nativeBalanceChange: number;
  tokenBalanceChanges: HeliusTokenBalanceChange[] | null;
}

export interface HeliusTokenTransfer {
  fromUserAccount: string | null;
  toUserAccount: string | null;
  fromTokenAccount: string | null;
  toTokenAccount: string | null;
  tokenAmount: number;
  mint: string;
}

export interface HeliusNativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number;
}

export interface HeliusEnhancedTransaction {
  signature: string;
  slot: number;
  timestamp: number;
  type: string;
  source: string;
  fee: number;
  feePayer: string;
  transactionError: unknown | null;
  accountData: HeliusAccountData[];
  tokenTransfers: HeliusTokenTransfer[];
  nativeTransfers: HeliusNativeTransfer[];
  instructions: Array<{
    programId: string;
    innerInstructions?: Array<{ programId: string }>;
  }>;
  events?: {
    swap?: {
      nativeInput?: { account: string; amount: string };
      nativeOutput?: { account: string; amount: string };
      tokenInputs?: Array<{
        userAccount: string;
        mint: string;
        rawTokenAmount: { tokenAmount: string; decimals: number };
      }>;
      tokenOutputs?: Array<{
        userAccount: string;
        mint: string;
        rawTokenAmount: { tokenAmount: string; decimals: number };
      }>;
    };
  };
}

function apiUrl(path: string, params: Record<string, string | number | undefined> = {}): string {
  const key = required('HELIUS_API_KEY');
  const url = new URL(`https://api.helius.xyz${path}`);
  url.searchParams.set('api-key', key);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/**
 * Parsed transaction history for an address, newest first.
 *
 * @param before  signature to page backwards from
 * @param until   stop once this signature is reached (our stored sync cursor)
 */
export async function getEnhancedHistory(
  address: string,
  opts: { limit?: number; before?: string; until?: string; type?: string } = {}
): Promise<HeliusEnhancedTransaction[]> {
  const { limit = 100, before, until, type } = opts;
  return request<HeliusEnhancedTransaction[]>(
    apiUrl(`/v0/addresses/${address}/transactions`, {
      limit: Math.min(limit, 100),
      before,
      until,
      type,
    }),
    { label: 'helius-history', retries: 3, timeoutMs: 20_000 }
  );
}

/**
 * Pages backwards until `untilSignature` is found or `maxTransactions` is hit.
 * Returns transactions newest-first.
 */
export async function getHistorySince(
  address: string,
  untilSignature: string | null,
  maxTransactions: number
): Promise<HeliusEnhancedTransaction[]> {
  const collected: HeliusEnhancedTransaction[] = [];
  let before: string | undefined;

  while (collected.length < maxTransactions) {
    const page = await getEnhancedHistory(address, {
      limit: Math.min(100, maxTransactions - collected.length),
      before,
      until: untilSignature ?? undefined,
    });

    if (!page.length) break;
    collected.push(...page);

    const last = page[page.length - 1];
    if (page.length < 100 || !last) break;
    before = last.signature;

    if (untilSignature && page.some((tx) => tx.signature === untilSignature)) break;
  }

  return untilSignature
    ? collected.filter((tx) => tx.signature !== untilSignature)
    : collected;
}

/** Enhanced parse for a specific batch of signatures (max 100). */
export async function parseTransactions(
  signatures: string[]
): Promise<HeliusEnhancedTransaction[]> {
  if (!signatures.length) return [];
  return request<HeliusEnhancedTransaction[]>(apiUrl('/v0/transactions'), {
    method: 'POST',
    body: JSON.stringify({ transactions: signatures.slice(0, 100) }),
    label: 'helius-parse',
    timeoutMs: 25_000,
  });
}

// --- RPC ---------------------------------------------------------------------

interface RpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

/**
 * JSON-RPC call.
 *
 * `params` is passed through as-is: standard Solana methods take a positional
 * array, while the DAS methods (getAsset, getAssetBatch, searchAssets) take a
 * named object. Forcing an array on a DAS method yields
 * "invalid type: map, expected a sequence".
 */
async function call<T>(
  endpoint: string,
  label: string,
  method: string,
  params: unknown[] | Record<string, unknown>
): Promise<T> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: method, method, params });
  const response = await request<RpcResponse<T>>(endpoint, {
    method: 'POST',
    body,
    label,
    retries: 3,
    timeoutMs: 20_000,
  });
  if (response.error) {
    throw new Error(`RPC ${method} failed: ${response.error.message}`);
  }
  return response.result as T;
}

/** Standard Solana JSON-RPC — follows `SOLANA_RPC_URL`, so any provider serves it. */
async function rpc<T>(method: string, params: unknown[] | Record<string, unknown>): Promise<T> {
  return call<T>(config.solana.rpcUrl, rpcLabel(), method, params);
}

/**
 * Digital Asset Standard call — `getAsset` / `getAssetBatch`.
 *
 * Kept on its own endpoint because DAS is a Metaplex extension rather than
 * standard RPC, so it does not follow `SOLANA_RPC_URL` when that is pointed at
 * a general provider. It also carries its own budget label: DAS and plain RPC
 * are billed by different accounts once the two are split, and marking one
 * exhausted must not silence the other.
 */
async function das<T>(method: string, params: unknown[] | Record<string, unknown>): Promise<T> {
  return call<T>(config.solana.dasUrl, 'helius-das', method, params);
}

export interface TokenAccountBalance {
  mint: string;
  amount: number;
  decimals: number;
}

/**
 * All SPL token balances for an owner, via `getTokenAccountsByOwner` with
 * jsonParsed encoding. Works against any RPC provider, not just Helius.
 */
export async function getTokenBalances(owner: string): Promise<TokenAccountBalance[]> {
  const result = await rpc<{
    value: Array<{
      account: {
        data: {
          parsed: {
            info: {
              mint: string;
              tokenAmount: { amount: string; decimals: number; uiAmount: number | null };
            };
          };
        };
      };
    }>;
  }>('getTokenAccountsByOwner', [
    owner,
    { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ]);

  const balances = new Map<string, TokenAccountBalance>();
  for (const entry of result?.value ?? []) {
    const info = entry.account.data.parsed.info;
    const amount = info.tokenAmount.uiAmount ?? 0;
    if (amount <= 0) continue;
    // A wallet can hold the same mint across several token accounts.
    const existing = balances.get(info.mint);
    if (existing) existing.amount += amount;
    else
      balances.set(info.mint, {
        mint: info.mint,
        amount,
        decimals: info.tokenAmount.decimals,
      });
  }

  return [...balances.values()];
}

export interface MintInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number;
  uiSupply: number;
}

/**
 * Mint account details — the two authorities and total supply.
 *
 * A live `mintAuthority` means supply can be inflated arbitrarily and a live
 * `freezeAuthority` means balances can be frozen; both are hard rug vectors and
 * both are visible here for free.
 */
export async function getMintInfo(mint: string): Promise<MintInfo | null> {
  const result = await rpc<{
    value: {
      data?: {
        parsed?: {
          info?: {
            mintAuthority: string | null;
            freezeAuthority: string | null;
            decimals: number;
            supply: string;
          };
        };
      };
    } | null;
  }>('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);

  const info = result?.value?.data?.parsed?.info;
  if (!info) return null;

  const decimals = info.decimals ?? 0;
  const raw = Number(info.supply ?? 0);

  return {
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    decimals,
    uiSupply: Number.isFinite(raw) ? raw / 10 ** decimals : 0,
  };
}

/**
 * Metadata update authority for a mint, via DAS `getAsset`.
 *
 * The closest on-chain proxy for "who deployed this". Callers must check it
 * against known platform authorities before calling it a creator.
 */
export async function getUpdateAuthority(mint: string): Promise<string | null> {
  try {
    const asset = await das<{
      authorities?: Array<{ address: string; scopes?: string[] }>;
    }>('getAsset', { id: mint });
    return asset?.authorities?.[0]?.address ?? null;
  } catch {
    return null;
  }
}

/** Native SOL balance in SOL units. */
export async function getSolBalance(owner: string): Promise<number> {
  const result = await rpc<{ value: number }>('getBalance', [owner, { commitment: 'confirmed' }]);
  return (result?.value ?? 0) / 1e9;
}

export interface AssetMetadata {
  mint: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  imageUri: string | null;
  /** USD price per token, when the indexer has one. */
  priceUsd: number | null;
}

/**
 * Batched token metadata AND pricing via the DAS `getAssetBatch` method.
 *
 * This is the workhorse for portfolio inventory: one RPC call resolves up to
 * 1000 mints to symbol, name, image, decimals and price. The alternative —
 * per-mint Birdeye lookups — costs one ~1s request each on a free key, which
 * made valuing a 124-token wallet take minutes.
 *
 * Prices here come from the indexer and can be staler or thinner than a
 * dedicated price feed, so callers should still prefer Birdeye for the mints
 * that matter most (quote legs, tracked memes) and use these for the long tail.
 */
export async function getAssetsBatch(mints: string[]): Promise<Map<string, AssetMetadata>> {
  const out = new Map<string, AssetMetadata>();
  if (!mints.length) return out;

  const unique = [...new Set(mints)];

  for (let i = 0; i < unique.length; i += 1000) {
    const batch = unique.slice(i, i + 1000);
    try {
      const assets = await das<
        Array<{
          id: string;
          content?: {
            metadata?: { symbol?: string; name?: string };
            links?: { image?: string };
          };
          token_info?: {
            decimals?: number;
            symbol?: string;
            price_info?: { price_per_token?: number };
          };
        } | null>
      >('getAssetBatch', { ids: batch });

      for (const asset of assets ?? []) {
        if (!asset?.id) continue;
        const meta = asset.content?.metadata ?? {};
        const info = asset.token_info ?? {};
        const price = info.price_info?.price_per_token;
        out.set(asset.id, {
          mint: asset.id,
          symbol: meta.symbol || info.symbol || null,
          name: meta.name || null,
          decimals: info.decimals ?? null,
          imageUri: asset.content?.links?.image ?? null,
          priceUsd: typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null,
        });
      }
    } catch (error) {
      // Metadata is enrichment; a failure must not sink a portfolio snapshot.
      console.warn('[helius] getAssetBatch failed:', (error as Error).message);
    }
  }

  return out;
}

/** Signature list for an address — cheap way to gauge activity without parsing. */
export async function getSignatures(
  address: string,
  limit = 100
): Promise<Array<{ signature: string; slot: number; blockTime: number | null; err: unknown }>> {
  return rpc('getSignaturesForAddress', [address, { limit: Math.min(limit, 1000) }]);
}

/** Largest holders of a mint — the cheapest whale-candidate source there is. */
/**
 * Top token accounts for a mint.
 *
 * This one method gets a fallback the others do not need. It is an expensive
 * whole-supply scan, and a general RPC provider will not always complete it:
 * measured against Alchemy, the same call failed with `-32001 Unable to
 * complete request at this time` for USDC, and for BONK failed once then
 * succeeded twice. It is also served by a visibly different backend there
 * (apiVersion 2.3.3, against 4.2.2 for every other method), so the flakiness is
 * structural rather than a passing outage.
 *
 * Failing here would leave forensics reporting "holder list unavailable" —
 * an infrastructure limit presented as a finding about the token, which is
 * exactly the class of bug this codebase keeps having to remove. So a failure
 * on the standard endpoint retries against the DAS endpoint, which on the
 * default configuration is Helius and handled this reliably.
 */
export async function getLargestTokenAccounts(
  mint: string
): Promise<Array<{ address: string; uiAmount: number }>> {
  type LargestAccounts = { value: Array<{ address: string; uiAmount: number | null }> };
  const params = [mint, { commitment: 'confirmed' }];

  let result: LargestAccounts | null = null;
  try {
    result = await rpc<LargestAccounts>('getTokenLargestAccounts', params);
  } catch (error) {
    // Only worth a second attempt when the two endpoints are actually different.
    if (config.solana.dasUrl === config.solana.rpcUrl) throw error;
    console.warn(
      `[helius] getTokenLargestAccounts failed on the standard RPC (${(error as Error).message}); retrying on the DAS endpoint.`
    );
    result = await das<LargestAccounts>('getTokenLargestAccounts', params);
  }

  return (result?.value ?? [])
    .filter((entry) => (entry.uiAmount ?? 0) > 0)
    .map((entry) => ({ address: entry.address, uiAmount: entry.uiAmount ?? 0 }));
}

/**
 * Resolves token *accounts* to their owner wallets. `getTokenLargestAccounts`
 * returns token accounts, which are useless as whale identities on their own.
 */
export async function getTokenAccountOwners(tokenAccounts: string[]): Promise<string[]> {
  if (!tokenAccounts.length) return [];
  const result = await rpc<{
    value: Array<{
      data: { parsed: { info: { owner: string } } } | null;
    } | null>;
  }>('getMultipleAccounts', [tokenAccounts.slice(0, 100), { encoding: 'jsonParsed' }]);

  const owners: string[] = [];
  for (const account of result?.value ?? []) {
    const owner = account?.data?.parsed?.info?.owner;
    if (owner) owners.push(owner);
  }
  return owners;
}

// --- Webhooks ----------------------------------------------------------------

export interface HeliusWebhook {
  webhookID: string;
  webhookURL: string;
  accountAddresses: string[];
  transactionTypes: string[];
  webhookType: string;
}

export async function listWebhooks(): Promise<HeliusWebhook[]> {
  // bypassBudget: see upsertWebhook — this is the read half of the same fix.
  return requestSoft<HeliusWebhook[]>(
    apiUrl('/v0/webhooks'),
    { label: 'helius-webhooks', bypassBudget: true },
    []
  );
}

/**
 * Creates or updates the tracker's webhook so Helius pushes whale transactions
 * to `/api/webhooks/helius` the moment they confirm.
 *
 * These calls deliberately bypass the budget guard. The subscription they write
 * is what determines how many billable deliveries arrive afterwards, so
 * refusing to spend one credit here would preserve the old firehose that spent
 * the allowance in the first place — the guard protecting the drain.
 */
export async function upsertWebhook(addresses: string[]): Promise<HeliusWebhook> {
  const webhookURL = `${config.app.url.replace(/\/$/, '')}/api/webhooks/helius`;
  const payload = {
    webhookURL,
    // Helius caps a single webhook at 100k addresses; we stay far below that.
    accountAddresses: addresses.slice(0, 100_000),
    /*
     * SWAP only.
     *
     * This was previously ['SWAP', 'TRANSFER', 'UNKNOWN'], which subscribes to
     * essentially every transaction an active wallet takes part in — dust
     * airdrops, SPL transfers, staking, anything unclassified. Across fifteen
     * whales that produced 333,719 deliveries, and the recorded results show
     * the overwhelming majority parsed to zero trades. Each one still cost a
     * Helius credit, a database read and a database write, which is how a
     * month's allowance disappeared.
     *
     * The tracker only ever ingests swaps: `parseSwaps` discards everything
     * else. Subscribing to types we then throw away is pure cost, so the
     * subscription now matches what the parser actually consumes.
     */
    transactionTypes: ['SWAP'],
    webhookType: config.app.isProd ? 'enhanced' : 'enhancedDevnet',
    authHeader: config.auth.webhookSecret,
  };

  const existing = (await listWebhooks()).find((hook) => hook.webhookURL === webhookURL);

  if (existing) {
    return request<HeliusWebhook>(apiUrl(`/v0/webhooks/${existing.webhookID}`), {
      method: 'PUT',
      body: JSON.stringify(payload),
      label: 'helius-webhook-update',
      bypassBudget: true,
    });
  }

  return request<HeliusWebhook>(apiUrl('/v0/webhooks'), {
    method: 'POST',
    body: JSON.stringify(payload),
    label: 'helius-webhook-create',
    bypassBudget: true,
  });
}
