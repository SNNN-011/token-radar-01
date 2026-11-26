import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DuplicateSlugError,
  InvalidSlugError,
  classify,
} from '../lib/universe.ts';
import type {
  ClassificationResult,
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

function statusCounts(result: ClassificationResult): Record<string, number> {
  return result.ledger.reduce<Record<string, number>>((counts, row) => {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  }, {});
}

test('classifies a clean token with a usable market cap as a peer', () => {
  const result = classify(makeSnapshot([makeToken()]));

  assert.equal(result.peers.length, 1);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.excluded.length, 0);
  assert.equal(result.ledger.length, 1);

  const row = onlyRow(result.ledger);
  assert.equal(row.slug, 'eth');
  assert.equal(row.status, 'peer');
  assert.equal(row.reason, 'peer');
  assert.deepEqual(row.flags, []);
});

test('treats usable market cap as a strong peer signal without name or symbol', () => {
  const input: NormalizedToken = {
    slug: 'mcap-only',
    marketCapUsd: 10,
    listedAt: '2024-01-01',
    change7d: 0,
  };

  const result = classify(makeSnapshot([input]));
  const row = onlyRow(result.peers);

  assert.equal(row.status, 'peer');
  assert.equal(row.reason, 'peer');
  assert.deepEqual(row.flags, []);
  assert.deepEqual(row.token, input);
});

test('excludes nonpositive or nonfinite market caps without a token signal', () => {
  const cases: Array<{
    marketCapUsd: number | null | undefined;
    flag: 'missing-market-cap' | 'unusable-market-cap';
  }> = [
    { marketCapUsd: undefined, flag: 'missing-market-cap' },
    { marketCapUsd: null, flag: 'missing-market-cap' },
    { marketCapUsd: 0, flag: 'unusable-market-cap' },
    { marketCapUsd: -1, flag: 'unusable-market-cap' },
    { marketCapUsd: Number.NaN, flag: 'unusable-market-cap' },
    { marketCapUsd: Number.POSITIVE_INFINITY, flag: 'unusable-market-cap' },
  ];

  cases.forEach(({ marketCapUsd, flag }) => {
    const result = classify(makeSnapshot([makeToken({ marketCapUsd })]));
    const row = onlyRow(result.excluded);

    assert.equal(result.peers.length, 0);
    assert.equal(result.candidates.length, 0);
    assert.equal(row.status, 'excluded');
    assert.equal(row.reason, 'ambiguous-symbol-only');
    assert.ok(row.flags.includes(flag));
  });
});

test('excludes a clear wrapper even when it has a usable market cap', () => {
  const result = classify(
    makeSnapshot([
      makeToken({ name: 'Wrapped Ether', symbol: 'wETH', marketCapUsd: 500 }),
    ]),
  );

  const row = onlyRow(result.excluded);
  assert.equal(row.status, 'excluded');
  assert.equal(row.reason, 'apparent-wrapper');
  assert.deepEqual(row.flags, []);
});

test('excludes a clear versioned name even when it has a usable market cap', () => {
  const result = classify(
    makeSnapshot([
      makeToken({ name: 'USD Coin v2', symbol: 'USDC', marketCapUsd: 100 }),
    ]),
  );

  const row = onlyRow(result.excluded);
  assert.equal(row.status, 'excluded');
  assert.equal(row.reason, 'versioned-name');
  assert.deepEqual(row.flags, []);
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

test('excludes a geckoId-identified token without a usable market cap', () => {
  const result = classify(
    makeSnapshot([
      makeToken({
        slug: 'gecko-token',
        name: 'Gecko Token',
        symbol: 'GCK',
        geckoId: 'gecko-token',
        marketCapUsd: 0,
      }),
    ]),
  );

  const row = onlyRow(result.excluded);
  assert.equal(row.status, 'excluded');
  assert.equal(row.reason, 'tokenized-without-usable-market-cap');
  assert.deepEqual(row.flags, ['unusable-market-cap']);
});

test('marks symbol-only metadata as ambiguous excluded, not a confirmed token', () => {
  const result = classify(
    makeSnapshot([
      makeToken({
        slug: 'maybe-token',
        name: 'Maybe Token',
        symbol: 'MAYBE',
        marketCapUsd: null,
      }),
    ]),
  );

  const row = onlyRow(result.excluded);
  assert.equal(row.status, 'excluded');
  assert.equal(row.reason, 'ambiguous-symbol-only');
  assert.deepEqual(row.flags, ['missing-market-cap']);
});

test('keeps truly missing token metadata with a display name as a candidate', () => {
  const result = classify(
    makeSnapshot([{ slug: 'name-only', name: 'Name Only' }]),
  );

  const row = onlyRow(result.candidates);
  assert.equal(row.status, 'candidate');
  assert.equal(row.reason, 'missing-token-metadata');
  assert.deepEqual(row.flags, [
    'missing-market-cap',
    'missing-listed-at',
    'missing-change-7d',
  ]);
});

test('excludes a row with no token metadata and no display identity', () => {
  const result = classify(makeSnapshot([{ slug: 'nothing' }]));

  const row = onlyRow(result.excluded);
  assert.equal(row.status, 'excluded');
  assert.equal(row.reason, 'missing-identity');
  assert.deepEqual(row.flags, [
    'missing-market-cap',
    'missing-listed-at',
    'missing-change-7d',
  ]);
});

test('keeps an otherwise eligible watchlist token out of peers', () => {
  const result = classify(
    makeSnapshot([
      makeToken({ slug: 'keeper', name: 'Keeper', symbol: 'KEEP', watchlist: true }),
    ]),
  );

  assert.equal(result.peers.length, 0);
  const row = onlyRow(result.candidates);
  assert.equal(row.status, 'candidate');
  assert.equal(row.reason, 'watchlist');
  assert.deepEqual(row.flags, ['already-tokenized']);
});

test('emits already-tokenized once when a watchlist row has both strong signals', () => {
  const result = classify(
    makeSnapshot([
      makeToken({
        slug: 'keeper-gecko',
        name: 'Keeper Gecko',
        symbol: 'KEEP',
        geckoId: 'keeper-gecko',
        marketCapUsd: 1_000,
        watchlist: true,
      }),
    ]),
  );

  const row = onlyRow(result.candidates);
  assert.equal(row.status, 'candidate');
  assert.equal(row.reason, 'watchlist');
  assert.deepEqual(row.flags, ['already-tokenized']);
});

test('preserves a watchlist wrapper and its tokenized signal', () => {
  const result = classify(
    makeSnapshot([
      makeToken({
        name: 'Wrapped Ether',
        symbol: 'wETH',
        geckoId: 'weth',
        marketCapUsd: 0,
        watchlist: true,
      }),
    ]),
  );

  const row = onlyRow(result.candidates);
  assert.equal(row.status, 'candidate');
  assert.equal(row.reason, 'watchlist');
  assert.deepEqual(row.flags, [
    'apparent-wrapper',
    'already-tokenized',
    'tokenized-without-usable-market-cap',
    'unusable-market-cap',
  ]);
});

test('preserves an ambiguous watchlist symbol and its weak signal', () => {
  const result = classify(
    makeSnapshot([
      makeToken({
        name: 'Mystery',
        symbol: 'MYST',
        marketCapUsd: null,
        watchlist: true,
      }),
    ]),
  );

  const row = onlyRow(result.candidates);
  assert.equal(row.reason, 'watchlist');
  assert.deepEqual(row.flags, ['ambiguous-symbol-only', 'missing-market-cap']);
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

test('flags a nonfinite change_7d without changing peer status', () => {
  const result = classify(
    makeSnapshot([makeToken({ change7d: Number.NaN })]),
  );

  const row = onlyRow(result.peers);
  assert.equal(row.reason, 'peer');
  assert.deepEqual(row.flags, ['invalid-change-7d']);
});

test('preserves raw listed_at without guessing a date format', () => {
  const result = classify(
    makeSnapshot([makeToken({ listedAt: 'not-a-real-date' })]),
  );

  const row = onlyRow(result.peers);
  assert.equal(row.reason, 'peer');
  assert.deepEqual(row.flags, []);
  assert.equal(row.token.listedAt, 'not-a-real-date');
});

test('copies nested chains and downstream metadata without sharing the array', () => {
  const chains = ['ethereum', 'base'];
  const input = makeToken({
    slug: 'multi-chain',
    tvlUsd: 123,
    category: 'DeFi',
    chains,
  });

  const result = classify(makeSnapshot([input]));
  const row = onlyRow(result.peers);

  assert.equal(row.token.tvlUsd, 123);
  assert.equal(row.token.category, 'DeFi');
  assert.deepEqual(row.token.chains, ['ethereum', 'base']);
  assert.notStrictEqual(row.token.chains, chains);
  assert.ok(Object.isFrozen(row.token.chains));
  assert.ok(Object.isFrozen(row.token));

  chains.push('solana');
  assert.deepEqual(row.token.chains, ['ethereum', 'base']);
});

test('rejects blank or outer-whitespace slugs without repairing them', () => {
  ['', '   ', ' eth ', 'eth '].forEach((slug) => {
    assert.throws(
      () => classify(makeSnapshot([makeToken({ slug })])),
      (error: unknown) => {
        assert.ok(error instanceof InvalidSlugError);
        assert.match(error.message, /slug/i);
        return true;
      },
    );
  });
});

test('uses exact slug values for duplicates and the ledger invariant', () => {
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

  const caseDistinct = classify(
    makeSnapshot([
      makeToken({ slug: 'eth' }),
      makeToken({ slug: 'ETH', name: 'Ether Uppercase' }),
    ]),
  );
  assert.deepEqual(
    caseDistinct.ledger.map((row) => row.slug),
    ['ETH', 'eth'],
  );
  assert.ok(caseDistinct.ledger.every((row) => row.slug === row.token.slug));
});

test('does not guess an authoritative universe from an unknown slug', () => {
  const slug = 'definitely-not-in-a-local-universe';
  const result = classify(makeSnapshot([makeToken({ slug })]));

  const row = onlyRow(result.peers);
  assert.equal(row.slug, slug);
  assert.equal(row.token.slug, slug);
});

test('freezes the result and every partition array', () => {
  const result = classify(makeSnapshot([makeToken()]));

  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.ledger));
  assert.ok(Object.isFrozen(result.peers));
  assert.ok(Object.isFrozen(result.candidates));
  assert.ok(Object.isFrozen(result.excluded));

  assert.throws(() => {
    (result.peers as unknown as LedgerRow[]).push(onlyRow(result.peers));
  }, TypeError);
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

  inputs.forEach((input) => {
    const row = result.ledger.find((candidate) => candidate.slug === input.slug);
    assert.ok(row, `missing ledger row for ${input.slug}`);
    assert.equal(row.slug, row.token.slug);
    assert.deepEqual(row.token, input);
  });
});

test('partitions 234 synthetic rows with 110 genuine candidates, not peers', () => {
  const peers = Array.from({ length: 100 }, (_, index) =>
    makeToken({
      slug: `peer-${String(index).padStart(3, '0')}`,
      name: index % 2 === 0 ? `Peer ${index}` : undefined,
      symbol: index % 3 === 0 ? undefined : `P${index}`,
      marketCapUsd: 1_000 + index,
    }),
  );
  const eligibleCandidates = Array.from({ length: 100 }, (_, index) =>
    makeToken({
      slug: `candidate-${String(index).padStart(3, '0')}`,
      watchlist: true,
    }),
  );
  const weakWatchlist = Array.from({ length: 10 }, (_, index) =>
    makeToken({
      slug: `watch-weak-${index}`,
      name: 'Watch Weak',
      symbol: 'WW',
      marketCapUsd: null,
      watchlist: true,
    }),
  );
  const wrappers = Array.from({ length: 6 }, (_, index) =>
    makeToken({
      slug: `wrapped-${index}`,
      name: 'Wrapped Token',
      symbol: 'wTOK',
      marketCapUsd: 100,
    }),
  );
  const versioned = Array.from({ length: 6 }, (_, index) =>
    makeToken({
      slug: `versioned-${index}`,
      name: 'Token v2',
      symbol: 'TOK',
      marketCapUsd: 100,
    }),
  );
  const geckoNoCap = Array.from({ length: 6 }, (_, index) =>
    makeToken({
      slug: `gecko-${index}`,
      name: 'Gecko Token',
      symbol: 'GCK',
      geckoId: `gecko-${index}`,
      marketCapUsd: 0,
    }),
  );
  const symbolOnly = Array.from({ length: 6 }, (_, index) =>
    makeToken({
      slug: `symbol-${index}`,
      name: 'Symbol Only',
      symbol: 'SYM',
      marketCapUsd: null,
    }),
  );

  const tokens = [
    ...peers,
    ...eligibleCandidates,
    ...weakWatchlist,
    ...wrappers,
    ...versioned,
    ...geckoNoCap,
    ...symbolOnly,
  ];
  const result = classify({ tokens });

  assert.equal(tokens.length, 234);
  assert.equal(result.ledger.length, 234);
  assert.equal(result.peers.length, 100);
  assert.equal(result.candidates.length, 110);
  assert.equal(result.excluded.length, 24);
  assert.deepEqual(statusCounts(result), {
    peer: 100,
    candidate: 110,
    excluded: 24,
  });
  assert.equal(
    result.peers.length + result.candidates.length + result.excluded.length,
    result.ledger.length,
  );
  assert.ok(result.candidates.length >= 100);
  assert.equal(new Set(result.ledger.map((row) => row.slug)).size, 234);
  assert.ok(result.ledger.every((row) => row.slug === row.token.slug));
  assert.equal(
    result.candidates.filter((row) => row.flags.includes('already-tokenized'))
      .length,
    100,
  );
  assert.ok(
    result.candidates.every(
      (row) => row.status === 'candidate' && row.reason === 'watchlist',
    ),
  );
  assert.ok(
    result.peers.every((row) => row.status === 'peer' && row.reason === 'peer'),
  );
  assert.ok(result.excluded.every((row) => row.status === 'excluded'));

  const weak = result.candidates.filter(
    (row) => row.token.marketCapUsd === null,
  );
  assert.equal(weak.length, 10);
  assert.ok(weak.every((row) => row.flags.includes('ambiguous-symbol-only')));

  const sortedSlugs = [...result.ledger]
    .map((row) => row.slug)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  assert.deepEqual(result.ledger.map((row) => row.slug), sortedSlugs);
});

test('orders ledger and every derived partition by exact slug codepoints', () => {
  const tokens = [
    makeToken({ slug: 'beta' }),
    makeToken({ slug: 'Alpha' }),
    makeToken({ slug: 'alpha', name: 'Alpha', symbol: 'ALPHA', marketCapUsd: 0 }),
    makeToken({ slug: 'Beta' }),
    makeToken({ slug: 'aardvark', watchlist: true }),
  ];

  const result = classify(makeSnapshot(tokens));

  assert.deepEqual(
    result.ledger.map((row) => row.slug),
    ['Alpha', 'Beta', 'aardvark', 'alpha', 'beta'],
  );
  assert.deepEqual(
    result.candidates.map((row) => row.slug),
    ['aardvark'],
  );
  assert.deepEqual(
    result.peers.map((row) => row.slug),
    ['Alpha', 'Beta', 'beta'],
  );
  assert.deepEqual(
    result.excluded.map((row) => row.slug),
    ['alpha'],
  );
});

test('returns empty partitions for an empty snapshot', () => {
  const result = classify({ tokens: [] });

  assert.deepEqual(result.ledger, []);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.peers, []);
  assert.deepEqual(result.excluded, []);
});
