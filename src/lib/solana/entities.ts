/**
 * Known non-holder addresses.
 *
 * Holder-concentration analysis is worthless without this. The largest holders
 * of almost any liquid token are AMM pool vaults, burn addresses and exchange
 * hot wallets — none of which represent a person who can decide to dump. Count
 * them as concentration and every healthy token looks like a rug.
 *
 * The reverse error matters too, so this list is deliberately conservative:
 * only addresses that can be identified with confidence appear here. Everything
 * else is reported as UNIDENTIFIED rather than guessed at, because calling a
 * real holder "an exchange" understates risk just as badly as the opposite
 * overstates it.
 */

export type EntityKind = 'amm' | 'burn' | 'exchange' | 'protocol' | 'unidentified';

export interface KnownEntity {
  kind: EntityKind;
  label: string;
}

export const KNOWN_ADDRESSES: Record<string, KnownEntity> = {
  // --- AMM authorities / vault owners ---------------------------------------
  // Raydium's V4 authority holds the token side of every V4 pool. It is a PDA
  // with no account data, so it reports as System-Program-owned and is
  // indistinguishable from a wallet without this entry.
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1': { kind: 'amm', label: 'Raydium AMM v4 authority' },
  GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ: { kind: 'amm', label: 'Raydium staking authority' },
  '5ZVJgwWxMsqXxRMYHXqMwH2hd4myX5Ef4Au2iUsuNQ7V': { kind: 'amm', label: 'Raydium authority' },
  '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin': { kind: 'exchange', label: 'Serum/OpenBook' },

  // --- Burn / incinerator ----------------------------------------------------
  '1nc1nerator11111111111111111111111111111111': { kind: 'burn', label: 'Incinerator (burn)' },
  '11111111111111111111111111111111': { kind: 'protocol', label: 'System Program' },

  // --- Platform metadata authorities -----------------------------------------
  // Shared across every token a launchpad mints, so it is NEVER the individual
  // developer. Reporting it as one would name the same wallet as the "dev" of
  // thousands of unrelated tokens.
  TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM: {
    kind: 'protocol',
    label: 'Pump.fun metadata authority (platform-wide, not the creator)',
  },

  // --- Pump.fun --------------------------------------------------------------
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': { kind: 'protocol', label: 'Pump.fun bonding curve' },
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: { kind: 'amm', label: 'PumpSwap AMM' },
};

/**
 * Address-shape heuristics for vault PDAs, used only to *soften* a claim — a
 * match downgrades a holder to "possible infrastructure", never to a confident
 * identification.
 */
export function looksLikeVault(address: string): boolean {
  // Raydium/Orca vault PDAs are frequently vanity-prefixed by their program.
  return /^(pool|vault|amm|Pool|Vault)/.test(address);
}

export function identifyAddress(address: string): KnownEntity {
  return KNOWN_ADDRESSES[address] ?? { kind: 'unidentified', label: 'Unidentified holder' };
}

/** Entities that hold supply without being able to decide to sell it. */
export function isNonDiscretionaryHolder(kind: EntityKind): boolean {
  return kind === 'amm' || kind === 'burn' || kind === 'protocol';
}
