/**
 * On-chain constants: program IDs used to attribute a swap to a venue, and the
 * quote/blue-chip mints that must never be classified as meme tokens.
 */

export const NATIVE_SOL = 'So11111111111111111111111111111111111111112';

/** Mints we price a trade *in*. A swap's non-quote leg is the traded token. */
export const QUOTE_MINTS: Record<string, { symbol: string; decimals: number }> = {
  [NATIVE_SOL]: { symbol: 'SOL', decimals: 9 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6 },
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': { symbol: 'PYUSD', decimals: 6 },
};

export const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX', // USDH
]);

/**
 * Blue chips, LSTs and infrastructure tokens. Large holdings here contribute to
 * portfolio value but never to "meme exposure".
 */
export const NON_MEME_MINTS = new Set<string>([
  NATIVE_SOL,
  ...STABLE_MINTS,
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // bSOL
  'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v', // jupSOL
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // RAY
  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', // ORCA
  'PYTH1oazi2ZTt6SGN8VJt3RJcYSVLFCkAoWtDpMPWjb', // PYTH
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', // JTO
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', // PYUSD-adjacent / PYTH net
  'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7', // DRIFT
  'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey', // MNDE
  'kinXdEcpDQeHPEuQnqmUgtYykqKGVFq6CeVX5iAHJq6', // KIN
  'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux', // HNT
  'W3aHFhbEztLdrcQ3fXBAiQe2vY5cwuKZLK1BQVsGqvB', // W (Wormhole)
  'CRTx1JouZhzSU6XytsE42UQraoGqiHgxabocVfARTy2s', // CRT infra
]);

export type Venue =
  | 'jupiter'
  | 'raydium'
  | 'pumpfun'
  | 'pumpswap'
  | 'orca'
  | 'meteora'
  | 'phoenix'
  | 'lifinity'
  | 'unknown';

/** Program ID → venue. Used when the indexer does not label the source. */
export const PROGRAM_VENUES: Record<string, Venue> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'jupiter',
  JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB: 'jupiter',
  JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uJvfo: 'jupiter',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'raydium', // AMM v4
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'raydium', // CLMM
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'raydium', // CPMM
  routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS: 'raydium', // router
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pumpfun', // bonding curve
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'pumpswap', // PumpSwap AMM
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'orca',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'meteora', // DLMM
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: 'meteora', // pools
  PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: 'phoenix',
  '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c': 'lifinity',
};

export const PUMPFUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

/** Programs a whale-relevant swap must touch. Drives the Helius webhook filter. */
export const TRACKED_PROGRAMS = Object.keys(PROGRAM_VENUES);

export function venueFromPrograms(programIds: string[]): Venue {
  // Jupiter routes through the underlying AMM, so check aggregators last —
  // the CPI'd AMM is the venue that actually filled, but users think in terms
  // of the aggregator they signed. Aggregator wins when both are present.
  let fallback: Venue = 'unknown';
  for (const id of programIds) {
    const venue = PROGRAM_VENUES[id];
    if (!venue) continue;
    if (venue === 'jupiter') return 'jupiter';
    if (fallback === 'unknown') fallback = venue;
  }
  return fallback;
}

/** Mints on pump.fun's bonding curve carry a `pump` suffix by convention. */
export function looksLikePumpfunMint(mint: string): boolean {
  return mint.endsWith('pump');
}

export const EXPLORERS = {
  tx: (sig: string) => `https://solscan.io/tx/${sig}`,
  account: (address: string) => `https://solscan.io/account/${address}`,
  token: (mint: string) => `https://solscan.io/token/${mint}`,
  birdeye: (mint: string) => `https://birdeye.so/token/${mint}?chain=solana`,
  pumpfun: (mint: string) => `https://pump.fun/${mint}`,
} as const;
