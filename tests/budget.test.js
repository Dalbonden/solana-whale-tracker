const assert = require('node:assert');
const { test } = require('node:test');
const {
  quotaSignal,
  providerFromLabel,
  isExhausted,
  markExhausted,
  markHealthy,
  exhaustionReason,
} = require('../.test-build/providers/budget.js');

test('recognises the exact Helius exhaustion body', () => {
  // Observed verbatim, and it arrives as plain text rather than JSON.
  assert.ok(quotaSignal(200, 'max usage reached'));
  assert.match(quotaSignal(200, 'max usage reached'), /Helius/);
});

test('recognises the exact Birdeye exhaustion body', () => {
  const body = '{"success":false,"message":"Compute units usage limit exceeded"}';
  assert.ok(quotaSignal(400, body));
  assert.match(quotaSignal(400, body), /Birdeye/);
});

test('a plain rate limit is NOT treated as exhaustion', () => {
  // The distinction that matters: a 429 should still back off and retry, and
  // must not blind the app to a provider that is merely busy.
  assert.equal(quotaSignal(429, 'Too many requests for a specific RPC call'), null);
  assert.equal(quotaSignal(500, 'internal error'), null);
  assert.equal(quotaSignal(200, '{"result":"ok"}'), null);
});

test('402 counts as exhaustion whatever the body says', () => {
  assert.ok(quotaSignal(402, ''));
});

test('generic allowance phrasings are caught', () => {
  assert.ok(quotaSignal(403, 'monthly limit reached'));
  assert.ok(quotaSignal(429, 'quota exceeded for this key'));
  assert.ok(quotaSignal(400, 'credit limit hit'));
});

test('matching is case-insensitive and survives an empty body', () => {
  assert.ok(quotaSignal(200, 'MAX USAGE REACHED'));
  assert.equal(quotaSignal(200, ''), null);
  assert.equal(quotaSignal(200, undefined), null);
});

test('labels map onto the provider that bills them', () => {
  assert.equal(providerFromLabel('helius-history'), 'helius');
  assert.equal(providerFromLabel('birdeye-multi-price'), 'birdeye');
  assert.equal(providerFromLabel('jupiter-price'), 'jupiter');
  assert.equal(providerFromLabel('gecko-ohlcv'), 'geckoterminal');
  assert.equal(providerFromLabel('api.example.com'), 'other');
});

test('a non-Helius RPC provider gets its own exhaustion state', () => {
  // Both endpoints are reached through helius.ts, so labelling a third-party
  // RPC 'helius-rpc' would let its outage silence DAS, which is billed by a
  // different account and may be perfectly healthy.
  assert.equal(providerFromLabel('solana-rpc'), 'rpc');
  assert.equal(providerFromLabel('helius-das'), 'helius');
  assert.notEqual(providerFromLabel('solana-rpc'), providerFromLabel('helius-das'));
});

test('exhausting the standalone RPC does not silence Helius DAS', () => {
  markExhausted('rpc', 'alchemy out', 10_000);
  assert.equal(isExhausted('rpc'), true);
  assert.equal(isExhausted('helius'), false, 'DAS must still be callable');
  markHealthy('rpc');
});

test('an exhausted provider is skipped until the cooldown expires', () => {
  markExhausted('birdeye', 'test reason', 10_000);
  assert.equal(isExhausted('birdeye'), true);
  assert.equal(exhaustionReason('birdeye'), 'test reason');
  markHealthy('birdeye');
  assert.equal(isExhausted('birdeye'), false);
});

test('the cooldown lets the provider be retried rather than staying dark', () => {
  // A zero cooldown is immediately elapsed, which is the recovery path: one
  // call goes through to test whether the allowance reset.
  markExhausted('solscan', 'spent', 0);
  assert.equal(isExhausted('solscan'), false, 'an elapsed cooldown must clear');
});

test('an untouched provider is never considered exhausted', () => {
  assert.equal(isExhausted('jupiter'), false);
  assert.equal(exhaustionReason('jupiter'), null);
});
