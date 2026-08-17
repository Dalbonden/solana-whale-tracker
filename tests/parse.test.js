const assert = require('node:assert');
const { test } = require('node:test');
const { parseSwaps, valueSwapUsd, computeBalanceDeltas } = require('../.test-build/parse.js');

const WHALE = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const RAYDIUM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const PUMPFUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const tracked = (mint) => mint === WIF || mint === BONK || mint.endsWith('pump');

/** Builds a Helius-shaped enhanced transaction. */
function tx({ programs = [JUPITER], solDelta = 0, tokens = [], error = null, ts = 1740000000 }) {
  return {
    signature: 'sig' + Math.random().toString(36).slice(2),
    slot: 300000000,
    timestamp: ts,
    type: 'SWAP',
    source: 'JUPITER',
    fee: 5000,
    feePayer: WHALE,
    transactionError: error,
    accountData: [
      { account: WHALE, nativeBalanceChange: solDelta * 1e9, tokenBalanceChanges: [] },
      ...tokens.map((t) => ({
        account: 'tokenacct' + t.mint.slice(0, 6),
        nativeBalanceChange: 0,
        tokenBalanceChanges: [
          {
            userAccount: t.owner ?? WHALE,
            tokenAccount: 'ta',
            mint: t.mint,
            rawTokenAmount: {
              tokenAmount: String(Math.round(t.amount * 10 ** (t.decimals ?? 6))),
              decimals: t.decimals ?? 6,
            },
          },
        ],
      })),
    ],
    tokenTransfers: [],
    nativeTransfers: [],
    instructions: programs.map((p) => ({ programId: p, innerInstructions: [] })),
  };
}

test('buy: spends SOL, receives a tracked meme token', () => {
  const swaps = parseSwaps(
    tx({ solDelta: -100, tokens: [{ mint: WIF, amount: 50000 }] }),
    WHALE,
    tracked
  );
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0].side, 'buy');
  assert.equal(swaps[0].venue, 'jupiter');
  assert.equal(swaps[0].tokenMint, WIF);
  assert.equal(swaps[0].tokenAmount, 50000);
  assert.equal(swaps[0].quoteMint, SOL);
  assert.equal(swaps[0].quoteAmount, 100);
});

test('sell: sends a tracked token, receives SOL', () => {
  const swaps = parseSwaps(
    tx({ programs: [RAYDIUM], solDelta: 250, tokens: [{ mint: BONK, amount: -900000, decimals: 5 }] }),
    WHALE,
    tracked
  );
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0].side, 'sell');
  assert.equal(swaps[0].venue, 'raydium');
  assert.equal(swaps[0].tokenAmount, 900000);
  assert.equal(swaps[0].quoteAmount, 250);
});

test('multi-hop route collapses to one trade priced off the real quote leg', () => {
  // SOL -> USDC -> WIF. USDC is transient and nets to ~0, so SOL must win.
  const swaps = parseSwaps(
    tx({
      solDelta: -80,
      tokens: [
        { mint: USDC, amount: -0.02 },
        { mint: WIF, amount: 42000 },
      ],
    }),
    WHALE,
    tracked
  );
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0].quoteMint, SOL, 'largest opposing quote leg should be chosen');
  assert.equal(swaps[0].quoteAmount, 80);
});

test('token-to-token swap records both tracked legs', () => {
  const swaps = parseSwaps(
    tx({ tokens: [{ mint: BONK, amount: -5000000, decimals: 5 }, { mint: WIF, amount: 3000 }] }),
    WHALE,
    tracked
  );
  assert.equal(swaps.length, 2);
  assert.equal(swaps.find((s) => s.tokenMint === WIF).side, 'buy');
  assert.equal(swaps.find((s) => s.tokenMint === BONK).side, 'sell');
});

test('plain transfer is not a swap', () => {
  // Only one mint moves; nothing came back.
  const swaps = parseSwaps(tx({ tokens: [{ mint: WIF, amount: -1000 }] }), WHALE, tracked);
  assert.equal(swaps.length, 0);
});

test('airdrop with fee-only SOL movement is not a swap', () => {
  const swaps = parseSwaps(
    tx({ solDelta: -0.005, tokens: [{ mint: WIF, amount: 1000 }] }),
    WHALE,
    tracked
  );
  assert.equal(swaps.length, 0, 'priority-fee noise must not read as a quote leg');
});

test('untracked token is filtered out', () => {
  const RANDOM = 'A1b2C3d4E5f6G7h8I9j0K1L2M3N4O5P6Q7R8S9T0U1V';
  const swaps = parseSwaps(
    tx({ solDelta: -10, tokens: [{ mint: RANDOM, amount: 500 }] }),
    WHALE,
    tracked
  );
  assert.equal(swaps.length, 0);
});

test('failed transaction produces nothing', () => {
  const swaps = parseSwaps(
    tx({ solDelta: -100, tokens: [{ mint: WIF, amount: 50000 }], error: { InstructionError: [3, 'Custom'] } }),
    WHALE,
    tracked
  );
  assert.equal(swaps.length, 0);
});

test("another wallet's balance changes are ignored", () => {
  const swaps = parseSwaps(
    tx({ solDelta: -100, tokens: [{ mint: WIF, amount: 50000, owner: 'SomeOtherWalletAddress1111111111111111111' }] }),
    WHALE,
    tracked
  );
  assert.equal(swaps.length, 0);
});

test('pump.fun venue is attributed and pump mints are tracked', () => {
  const PUMPMINT = 'A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump';
  const swaps = parseSwaps(
    tx({ programs: [PUMPFUN], solDelta: -30, tokens: [{ mint: PUMPMINT, amount: 8000000 }] }),
    WHALE,
    tracked
  );
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0].venue, 'pumpfun');
});

test('jupiter wins venue attribution over the AMM it routes through', () => {
  const swaps = parseSwaps(
    tx({ programs: [RAYDIUM, JUPITER], solDelta: -10, tokens: [{ mint: WIF, amount: 5000 }] }),
    WHALE,
    tracked
  );
  assert.equal(swaps[0].venue, 'jupiter');
});

test('valuation prefers the quote leg over a thin token price', () => {
  const swap = {
    tokenMint: WIF,
    tokenAmount: 50000,
    quoteMint: SOL,
    quoteAmount: 100,
  };
  const prices = new Map([[SOL, 180], [WIF, 0.0001]]); // token price deliberately wrong
  const { usdValue, priceUsd } = valueSwapUsd(swap, prices);
  assert.equal(usdValue, 18000, 'should value 100 SOL at $180, not 50k WIF at $0.0001');
  assert.equal(priceUsd, 18000 / 50000);
});

test('valuation falls back to token price when quote is unpriced', () => {
  const swap = { tokenMint: WIF, tokenAmount: 1000, quoteMint: null, quoteAmount: null };
  const { usdValue } = valueSwapUsd(swap, new Map([[WIF, 2.5]]));
  assert.equal(usdValue, 2500);
});

test('valuation returns 0 rather than guessing when nothing is priced', () => {
  const swap = { tokenMint: WIF, tokenAmount: 1000, quoteMint: SOL, quoteAmount: 5 };
  const { usdValue, priceUsd } = valueSwapUsd(swap, new Map());
  assert.equal(usdValue, 0);
  assert.equal(priceUsd, null);
});

test('balances aggregate across multiple token accounts of the same mint', () => {
  const t = tx({ tokens: [{ mint: WIF, amount: 100 }, { mint: WIF, amount: 250 }] });
  const deltas = computeBalanceDeltas(t, WHALE);
  assert.equal(deltas.get(WIF), 350);
});
