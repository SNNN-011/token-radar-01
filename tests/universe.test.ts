import test from 'node:test';
import assert from 'node:assert/strict';

import { DuplicateSlugError, InvalidSlugError, classify } from '../lib/universe.ts';
import type {
  LedgerRow,
  NormalizedSnapshot,
  NormalizedToken,
} from '../lib/universe.ts';

function makeToken(overrides: Partial<NormalizedToken> = {}): NormalizedToken {
  return {
    slug: 'eth',
    name: 'Ether',
    symbol: 'ETH',
    marketCapUsd: 1_000,
    listedAt: '2020-01-01',
    change7d: 1.25,
    watchlist: false,
    ...overrides,
  };
}

function makeSnapshot(tokens: readonly NormalizedToken[]): NormalizedSnapshot {
  return { tokens };
}

function onlyRow(rows: readonly LedgerRow[]): LedgerRow {
  assert.equal(rows.length, 1);
  return rows[0] as LedgerRow;
}

test('classifies an unequivocal token with a usable positive market cap as a peer', () => {
  const result = classify(makeSnapshot([makeToken()]));

  assert.equal(result.peers.length, 1);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.ledger.length, 1);

  const row = onlyRow(result.ledger);
  assert.equal(row.slug, 'eth');
  assert.equal(row.status, 'peer');
  assert.equal(row.reason, 'peer');
  assert.deepEqual(row.flags, []);
});

test('classifies tokens without a usable positive market cap as candidates', () => {
  const cases: Array<{
    marketCapUsd: number | null | undefined;
    reason: string;
  }> = [
    { marketCapUsd: undefined, reason: 'missing-market-cap' },
    { marketCapUsd: null, reason: 'missing-market-cap' },
    { marketCapUsd: 0, reason: 'unusable-market-cap' },
    { marketCapUsd: -1, reason: 'unusable-market-cap' },
    { marketCapUsd: Number.NaN, reason: 'unusable-market-cap' },
    { marketCapUsd: Number.POSITIVE_INFINITY, reason: 'unusable-market-cap' },
  ];

  for (const { marketCapUsd, reason } of cases) {
    const result = classify(makeSnapshot([makeToken({ marketCapUsd })]));
    const row = onlyRow(result.ledger);

    assert.equal(result.peers.length, 0);
    assert.equal(result.candidates.length, 1);
    assert.equal(row.reason, reason);
    assert.equal(row.status, 'candidate');
  }
});

test('orders ledger and derived lists by slug with codepoint determinism', () => {
  const tokens = [
    makeToken({ slug: 'beta' }),
    makeToken({ slug: 'Alpha' }),
    makeToken({ slug: 'alpha', name: 'Alpha', symbol: 'ALPHA', marketCapUsd: 0 }),
    makeToken({ slug: 'Beta' }),
  ];

  const result = classify(makeSnapshot(tokens));

  assert.deepEqual(
    result.ledger.map((row) => row.slug),
    ['Alpha', 'Beta', 'alpha', 'beta'],
  );
  assert.deepEqual(
    result.candidates.map((row) => row.slug),
    ['alpha'],
  );
  assert.deepEqual(
    result.peers.map((row) => row.slug),
    ['Alpha', 'Beta', 'beta'],
  );
});

test('emits one lossless ledger row per input token', () => {
  const inputs = [
    makeToken({ slug: 'eth' }),
    makeToken({ slug: 'usdc', name: 'USD Coin', symbol: 'USDC', marketCapUsd: 0 }),
    makeToken({ slug: 'arb', name: 'Arbitrum', symbol: 'ARB', watchlist: true }),
    makeToken({ slug: 'op', name: 'Optimism', symbol: 'OP', marketCapUsd: 42 }),
  ];

  const result = classify(makeSnapshot(inputs));

  assert.equal(result.ledger.length, inputs.length);
  assert.equal(new Set(result.ledger.map((row) => row.slug)).size, inputs.length);

  for (const input of inputs) {
    const row = result.ledger.find((candidate) => candidate.slug === input.slug);
    assert.ok(row, `missing ledger row for ${input.slug}`);
    assert.deepEqual(row.token, input);
  }
});

test('rejects duplicate slugs instead of emitting two ledger rows', () => {
  assert.throws(
    () =>
      classify(
        makeSnapshot([
          makeToken({ slug: 'eth' }),
          makeToken({ slug: 'eth', name: 'Ether Again' }),
        ]),
      ),
    (error: unknown) => {
      assert.ok(error instanceof DuplicateSlugError);
      assert.match(error.message, /duplicate slug/i);
      assert.match(error.message, /eth/);
      return true;
    },
  );
});

test('preserves a watchlist token in candidates even when it looks like a wrapper', () => {
  const result = classify(
    makeSnapshot([
      makeToken({
        name: 'Wrapped Ether',
        symbol: 'wETH',
        marketCapUsd: 0,
        watchlist: true,
      }),
    ]),
  );

  assert.equal(result.peers.length, 0);
  const row = onlyRow(result.candidates);
  assert.equal(row.reason, 'watchlist');
  assert.deepEqual(row.flags, ['apparent-wrapper', 'unusable-market-cap']);
});

test('keeps an otherwise eligible watchlist token out of peers', () => {
  const result = classify(
    makeSnapshot([
      makeToken({ slug: 'keeper', name: 'Keeper', symbol: 'KEEP', watchlist: true }),
    ]),
  );

  assert.equal(result.peers.length, 0);
  const row = onlyRow(result.candidates);
  assert.equal(row.reason, 'watchlist');
  assert.deepEqual(row.flags, []);
});

test('detects clear wrapper conventions by name or lowercase-w symbol', () => {
  const byName = classify(
    makeSnapshot([makeToken({ name: 'Wrapped Ether', symbol: 'ETH' })]),
  );
  const bySymbol = classify(
    makeSnapshot([makeToken({ name: 'Ether', symbol: 'wETH' })]),
  );

  assert.equal(onlyRow(byName.candidates).reason, 'apparent-wrapper');
  assert.equal(onlyRow(bySymbol.candidates).reason, 'apparent-wrapper');
  assert.equal(byName.peers.length, 0);
  assert.equal(bySymbol.peers.length, 0);
});

test('does not guess wrapper status from an uppercase W symbol', () => {
  const result = classify(
    makeSnapshot([
      makeToken({ slug: 'win', name: 'Wink', symbol: 'WIN', marketCapUsd: 10 }),
    ]),
  );

  const row = onlyRow(result.peers);
  assert.equal(row.reason, 'peer');
  assert.deepEqual(row.flags, []);
});

test('classifies a clear version suffix in the name as a candidate', () => {
  const result = classify(
    makeSnapshot([
      makeToken({ name: 'USD Coin v2', symbol: 'USDC', marketCapUsd: 100 }),
    ]),
  );

  const row = onlyRow(result.candidates);
  assert.equal(row.reason, 'versioned-name');
  assert.deepEqual(row.flags, []);
});

test('does not treat an ordinary word beginning with V as a version', () => {
  const result = classify(
    makeSnapshot([
      makeToken({ slug: 'vita', name: 'Vitality', symbol: 'VITA', marketCapUsd: 5 }),
    ]),
  );

  const row = onlyRow(result.peers);
  assert.equal(row.reason, 'peer');
  assert.deepEqual(row.flags, []);
});

test('accepts a clean token with missing listed_at and change_7d as a peer', () => {
  const result = classify({
    tokens: [
      {
        slug: 'fresh',
        name: 'Fresh',
        symbol: 'FRESH',
        marketCapUsd: 25,
      },
    ],
  });

  const row = onlyRow(result.peers);
  assert.equal(row.reason, 'peer');
  assert.deepEqual(row.flags, ['missing-listed-at', 'missing-change-7d']);
});

test('classifies a token with no name or symbol as missing identity', () => {
  const result = classify(
    makeSnapshot([
      makeToken({ name: '   ', symbol: null, marketCapUsd: 10 }),
    ]),
  );

  assert.equal(result.peers.length, 0);
  const row = onlyRow(result.candidates);
  assert.equal(row.reason, 'missing-identity');
  assert.deepEqual(row.flags, []);
});

test('classifies partial token identity as ambiguous rather than missing', () => {
  const missingSymbol = classify(
    makeSnapshot([makeToken({ name: 'Only A Name', symbol: '   ', marketCapUsd: 10 })]),
  );
  const missingName = classify(
    makeSnapshot([makeToken({ name: null, symbol: 'ONLY', marketCapUsd: 10 })]),
  );

  assert.equal(onlyRow(missingSymbol.candidates).reason, 'ambiguous-identity');
  assert.equal(onlyRow(missingName.candidates).reason, 'ambiguous-identity');
  assert.equal(missingSymbol.peers.length, 0);
  assert.equal(missingName.peers.length, 0);
});

test('preserves an ambiguous watchlist token and records the identity flag', () => {
  const result = classify(
    makeSnapshot([
      makeToken({
        name: 'Mystery',
        symbol: '',
        marketCapUsd: 10,
        watchlist: true,
      }),
    ]),
  );

  const row = onlyRow(result.candidates);
  assert.equal(row.reason, 'watchlist');
  assert.deepEqual(row.flags, ['ambiguous-identity']);
});

test('rejects a blank slug instead of inventing a ledger key', () => {
  assert.throws(
    () => classify(makeSnapshot([makeToken({ slug: '   ' })])),
    (error: unknown) => {
      assert.ok(error instanceof InvalidSlugError);
      assert.match(error.message, /slug/i);
      return true;
    },
  );
});

test('trims identity text for classification without altering the ledger copy', () => {
  const input = makeToken({
    slug: '  eth  ',
    name: '  Ether  ',
    symbol: ' ETH ',
    marketCapUsd: 5,
  });

  const result = classify(makeSnapshot([input]));

  const row = onlyRow(result.peers);
  assert.equal(row.slug, 'eth');
  assert.equal(row.reason, 'peer');
  assert.equal(row.token.name, '  Ether  ');
  assert.equal(row.token.symbol, ' ETH ');
  assert.equal(row.token.slug, '  eth  ');
});

test('returns empty collections for an empty snapshot', () => {
  const result = classify({ tokens: [] });

  assert.deepEqual(result.ledger, []);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.peers, []);
});
