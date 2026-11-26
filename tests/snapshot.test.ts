import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import {
  SnapshotSchemaError,
  adaptSnapshot,
  parseSnapshot,
} from '../lib/snapshot.ts';
import type {
  SnapshotExclusionReason,
  SnapshotLedgerRow,
  SnapshotReport,
} from '../lib/snapshot.ts';

const AS_OF = '2026-11-14';
const SOURCE =
  'DefiLlama https://api.llama.fi/protocols, fetched 2026-11-14T01:18:33.201Z';
const FLOOR = 50_000_000;

function protocol(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    slug: 'alpha',
    name: 'Alpha',
    category: 'Dexs',
    chains: ['Ethereum'],
    tvl_usd: FLOOR,
    change_7d: 1.25,
    mcap_usd: null,
    listed_at: '2024-01-01',
    gecko_id: null,
    symbol: null,
    ...overrides,
  };
}

function doc(
  protocols: readonly unknown[],
  watchlist: readonly unknown[] = [],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    as_of: AS_OF,
    source: SOURCE,
    floor_usd: FLOOR,
    protocols,
    watchlist,
    ...overrides,
  };
}

function schemaError(
  input: unknown,
  expectedPath?: RegExp,
): SnapshotSchemaError {
  assert.throws(
    () => parseSnapshot(input),
    (error: unknown) => {
      assert.ok(error instanceof SnapshotSchemaError);
      if (expectedPath !== undefined) {
        assert.match(error.path, expectedPath);
      }
      return true;
    },
  );
  try {
    parseSnapshot(input);
  } catch (error: unknown) {
    return error as SnapshotSchemaError;
  }
  throw new Error('expected parseSnapshot to throw');
}

function onlyRow(
  rows: readonly SnapshotLedgerRow[],
): SnapshotLedgerRow {
  assert.equal(rows.length, 1);
  return rows[0] as SnapshotLedgerRow;
}

function exclusionsOf(report: SnapshotReport, slug: string): readonly SnapshotExclusionReason[] {
  const row = report.ledger.find((entry) => entry.slug === slug);
  assert.ok(row, `missing ledger row for ${slug}`);
  return row.exclusions;
}

test('maps documented fields into the header and NormalizedToken shape', () => {
  const input = doc(
    [
      protocol({
        slug: 'watch-alpha',
        name: 'Watch Alpha',
        category: null,
        chains: [],
        tvl_usd: FLOOR,
        change_7d: null,
        mcap_usd: null,
        listed_at: null,
        gecko_id: null,
        symbol: null,
      }),
      protocol({
        slug: 'peer-token',
        name: 'Peer Token',
        category: 'Dexs',
        chains: ['Ethereum', 'Base'],
        tvl_usd: 5_000_000,
        change_7d: -4,
        mcap_usd: 123_456,
        listed_at: '2023-05-06',
        gecko_id: 'peer-token',
        symbol: 'PEER',
      }),
    ],
    ['watch-alpha'],
  );

  const parsed = parseSnapshot(input);
  assert.equal(parsed.asOf, AS_OF);
  assert.equal(parsed.source, SOURCE);
  assert.equal(parsed.floorUsd, FLOOR);
  assert.equal(parsed.tokens.length, 2);

  assert.deepEqual(parsed.tokens[0], {
    slug: 'watch-alpha',
    name: 'Watch Alpha',
    category: null,
    chains: [],
    tvlUsd: FLOOR,
    change7d: null,
    marketCapUsd: null,
    listedAt: null,
    geckoId: null,
    symbol: null,
    watchlist: true,
  });
  assert.deepEqual(parsed.tokens[1], {
    slug: 'peer-token',
    name: 'Peer Token',
    category: 'Dexs',
    chains: ['Ethereum', 'Base'],
    tvlUsd: 5_000_000,
    change7d: -4,
    marketCapUsd: 123_456,
    listedAt: '2023-05-06',
    geckoId: 'peer-token',
    symbol: 'PEER',
    watchlist: false,
  });

  const report = adaptSnapshot(input);
  assert.equal(report.asOf, AS_OF);
  assert.equal(report.source, SOURCE);
  assert.equal(report.floorUsd, FLOOR);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0]?.reason, 'watchlist');
  assert.equal(report.peers.length, 1);
  assert.equal(report.excluded.length, 0);
});

test('rejects non-object and inexact top-level shapes', () => {
  [null, 42, 'snapshot', [], undefined].forEach((value) => {
    schemaError(value, /snapshot/);
  });

  const missing = doc([]);
  delete missing.watchlist;
  schemaError(missing, /snapshot\.watchlist/);

  schemaError(doc([], [], { extra: true }), /snapshot\.extra/);

  schemaError(doc([], [], { as_of: undefined }), /snapshot\.as_of/);
});

test('rejects malformed as_of and source timestamps', () => {
  const badDates = ['2026-2-14', '2026-02-30', '14-11-2026', '2026-11-14T00:00:00Z'];
  badDates.forEach((asOf) => {
    schemaError(doc([], [], { as_of: asOf }), /snapshot\.as_of/);
  });

  const badSources = [
    'DefiLlama https://api.llama.fi/protocols',
    'DefiLlama https://example.com/protocols, fetched 2026-11-14T01:18:33.201Z',
    'DefiLlama https://api.llama.fi/protocols, fetched 2026-11-15T01:18:33.201Z',
    'DefiLlama https://api.llama.fi/protocols, fetched 2026-11-14T25:18:33.201Z',
    'DefiLlama https://api.llama.fi/protocols, fetched 2026-02-30T01:18:33Z',
    42,
  ];
  badSources.forEach((source) => {
    schemaError(doc([], [], { source }), /snapshot\.source/);
  });

  assert.doesNotThrow(() =>
    parseSnapshot(
      doc([], [], {
        source:
          'DefiLlama https://api.llama.fi/protocols, fetched 2026-11-14T01:18:33Z',
      }),
    ),
  );
});

test('rejects every invalid protocol field type and impossible listed_at', () => {
  const badProtocols: Array<{ field: string; value: unknown }> = [
    { field: 'slug', value: '' },
    { field: 'slug', value: '   ' },
    { field: 'slug', value: ' alpha ' },
    { field: 'slug', value: 42 },
    { field: 'name', value: null },
    { field: 'name', value: 42 },
    { field: 'category', value: 42 },
    { field: 'category', value: undefined },
    { field: 'chains', value: 'Ethereum' },
    { field: 'chains', value: ['Ethereum', 42] },
    { field: 'tvl_usd', value: '50000000' },
    { field: 'tvl_usd', value: -1 },
    { field: 'tvl_usd', value: 1.5 },
    { field: 'tvl_usd', value: Number.NaN },
    { field: 'tvl_usd', value: Number.POSITIVE_INFINITY },
    { field: 'change_7d', value: '1.25' },
    { field: 'change_7d', value: Number.NaN },
    { field: 'change_7d', value: Number.NEGATIVE_INFINITY },
    { field: 'mcap_usd', value: '123' },
    { field: 'mcap_usd', value: 1.5 },
    { field: 'mcap_usd', value: Number.POSITIVE_INFINITY },
    { field: 'listed_at', value: '2026-02-30' },
    { field: 'listed_at', value: '2026-1-04' },
    { field: 'listed_at', value: 20260104 },
    { field: 'gecko_id', value: 42 },
    { field: 'symbol', value: 42 },
  ];

  badProtocols.forEach(({ field, value }) => {
    schemaError(doc([protocol({ [field]: value })]), new RegExp(field));
  });

  schemaError(doc([protocol()], [], { floor_usd: 0 }), /snapshot\.floor_usd/);
  schemaError(doc([protocol()], [], { floor_usd: 1.5 }), /snapshot\.floor_usd/);
  schemaError(doc([protocol()], [], { floor_usd: '50000000' }), /snapshot\.floor_usd/);

  const missingField = protocol();
  delete missingField.symbol;
  schemaError(doc([missingField]), /protocols\[0\]\.symbol/);

  schemaError(doc([protocol({ extra: true })]), /protocols\[0\]\.extra/);
  schemaError(doc([42]), /protocols\[0\]/);
});

test('accepts every documented nullable value without inventing defaults', () => {
  const input = doc([
    protocol({
      slug: 'null-heavy',
      name: 'Null Heavy',
      category: null,
      chains: [],
      tvl_usd: 0,
      change_7d: null,
      mcap_usd: null,
      listed_at: null,
      gecko_id: null,
      symbol: null,
    }),
  ]);
  const parsed = parseSnapshot(input);
  const token = parsed.tokens[0];

  assert.ok(token);
  assert.equal(token.category, null);
  assert.equal(token.change7d, null);
  assert.equal(token.marketCapUsd, null);
  assert.equal(token.listedAt, null);
  assert.equal(token.geckoId, null);
  assert.equal(token.symbol, null);
  assert.deepEqual(token.chains, []);
  assert.equal(token.tvlUsd, 0);
  assert.equal(token.watchlist, false);
});

test('preserves negative market-cap sentinels instead of coercing them to null', () => {
  const report = adaptSnapshot(
    doc([
      protocol({
        slug: 'negative-mcap',
        name: 'Negative Mcap',
        gecko_id: 'negative-mcap',
        symbol: 'NEG',
        mcap_usd: -1,
      }),
    ]),
  );

  const row = onlyRow(report.excluded);
  assert.equal(row.token.marketCapUsd, -1);
  assert.equal(row.reason, 'tokenized-without-usable-market-cap');
  assert.deepEqual(row.flags, ['unusable-market-cap']);
});

test('rejects duplicate protocol slugs and invalid watchlist references', () => {
  schemaError(
    doc([protocol({ slug: 'same' }), protocol({ slug: 'same' })]),
    /protocols\[1\]\.slug/,
  );

  schemaError(doc([protocol()], ['missing']), /watchlist\[0\]/);
  schemaError(doc([protocol()], [42]), /watchlist\[0\]/);
  schemaError(doc([protocol()], ['']), /watchlist\[0\]/);
  schemaError(doc([protocol()], [' alpha ']), /watchlist\[0\]/);
  schemaError(doc([protocol()], ['alpha', 'alpha']), /watchlist\[1\]/);
  schemaError(doc([protocol()], 'alpha'), /snapshot\.watchlist/);
});

test('keeps exact slug strings and sorts every output by codepoint', () => {
  const report = adaptSnapshot(
    doc([
      protocol({ slug: 'beta', name: 'Beta' }),
      protocol({ slug: 'Alpha', name: 'Alpha Upper' }),
      protocol({ slug: 'alpha', name: 'Alpha Lower' }),
    ]),
  );

  assert.deepEqual(
    report.ledger.map((row) => row.slug),
    ['Alpha', 'alpha', 'beta'],
  );
  assert.deepEqual(
    report.candidates.map((row) => row.slug),
    ['Alpha', 'alpha', 'beta'],
  );
  assert.ok(report.ledger.every((row) => row.slug === row.token.slug));
});

test('applies every visible exclusion rule to non-watchlist candidates', () => {
  const cases: Array<{
    slug: string;
    name?: string;
    category?: string | null;
    reasons: readonly SnapshotExclusionReason[];
  }> = [
    {
      slug: 'name-staked',
      name: 'Staked Ether',
      reasons: ['wrapped-or-staked-name'],
    },
    {
      slug: 'name-wrapped',
      name: 'Gold Wrapped',
      reasons: ['wrapped-or-staked-name'],
    },
    {
      slug: 'category-bridge',
      category: 'Bridge',
      reasons: ['bridged-category'],
    },
    {
      slug: 'category-canonical-bridge',
      category: 'Canonical Bridge',
      reasons: ['bridged-category'],
    },
    {
      slug: 'category-liquid-staking',
      category: 'Liquid Staking',
      reasons: ['liquid-staking-category'],
    },
    {
      slug: 'category-liquid-restaking',
      category: 'Liquid Restaking',
      reasons: ['liquid-restaking-category'],
    },
    {
      slug: 'category-restaked-btc',
      category: 'Restaked BTC',
      reasons: ['restaked-btc-category'],
    },
    {
      slug: 'category-cex',
      category: 'CEX',
      reasons: ['cex-category'],
    },
    {
      slug: 'exchange-coinbase',
      name: 'Coinbase Prime',
      reasons: ['exchange-branded-name'],
    },
    {
      slug: 'exchange-okx',
      name: 'OKX xBTC',
      reasons: ['exchange-branded-name'],
    },
    {
      slug: 'version-decimal',
      name: 'Protocol 2.0',
      reasons: ['versioned-name'],
    },
  ];

  const report = adaptSnapshot(
    doc(
      cases.map((entry) =>
        protocol({
          slug: entry.slug,
          name: entry.name ?? 'Ordinary Name',
          category: entry.category === undefined ? 'Dexs' : entry.category,
        }),
      ),
    ),
  );

  assert.equal(report.candidates.length, 0);
  assert.equal(report.excluded.length, cases.length);
  cases.forEach((entry) => {
    const row = report.ledger.find((candidate) => candidate.slug === entry.slug);
    assert.ok(row, `missing row for ${entry.slug}`);
    assert.equal(row.status, 'excluded');
    assert.equal(row.reason, 'missing-token-metadata');
    assert.deepEqual(row.exclusions, entry.reasons);
  });
});

test('preserves every matching reason, in documented rule order, on one row', () => {
  const report = adaptSnapshot(
    doc([
      protocol({
        slug: 'multi-rule',
        name: 'Binance Staked ETH',
        category: 'Liquid Staking',
      }),
      protocol({
        slug: 'version-and-bridge',
        name: 'Gateway 2.0',
        category: 'Bridge',
      }),
    ]),
  );

  assert.deepEqual(exclusionsOf(report, 'multi-rule'), [
    'wrapped-or-staked-name',
    'liquid-staking-category',
    'exchange-branded-name',
  ]);
  assert.deepEqual(exclusionsOf(report, 'version-and-bridge'), [
    'versioned-name',
    'bridged-category',
  ]);
});

test('keeps the watchlist authoritative over every visible exclusion rule', () => {
  const report = adaptSnapshot(
    doc(
      [
        protocol({
          slug: 'watched-staked',
          name: 'Binance Staked ETH',
          category: 'Liquid Staking',
        }),
      ],
      ['watched-staked'],
    ),
  );

  const row = onlyRow(report.candidates);
  assert.equal(row.status, 'candidate');
  assert.equal(row.reason, 'watchlist');
  assert.deepEqual(row.exclusions, []);
  assert.equal(report.excluded.length, 0);
  assert.equal(row.token.watchlist, true);
});

test('leaves peers and core exclusions untouched by the snapshot overlay', () => {
  const report = adaptSnapshot(
    doc([
      protocol({
        slug: 'staked-peer',
        name: 'Staked Gold',
        category: 'Liquid Staking',
        symbol: 'GOLD',
        gecko_id: 'gold',
        mcap_usd: 10_000,
      }),
      protocol({
        slug: 'wrapped-peer',
        name: 'Wrapped Ether',
        symbol: 'wETH',
        gecko_id: 'weth',
        mcap_usd: 10_000,
      }),
    ]),
  );

  const peer = report.ledger.find((row) => row.slug === 'staked-peer');
  assert.ok(peer);
  assert.equal(peer.status, 'peer');
  assert.equal(peer.reason, 'peer');
  assert.deepEqual(peer.exclusions, []);

  const coreExcluded = report.ledger.find((row) => row.slug === 'wrapped-peer');
  assert.ok(coreExcluded);
  assert.equal(coreExcluded.status, 'excluded');
  assert.equal(coreExcluded.reason, 'apparent-wrapper');
  assert.deepEqual(coreExcluded.exclusions, []);
});

test('does not infer parentProtocol and never uses the floor as a ceiling', () => {
  const report = adaptSnapshot(
    doc([
      protocol({
        slug: 'above-floor-mystery',
        name: 'Mystery Launch',
        category: 'Yield',
        tvl_usd: FLOOR,
      }),
      protocol({
        slug: 'below-floor-mystery',
        name: 'Small Launch',
        category: 'Yield',
        tvl_usd: FLOOR - 1,
      }),
      protocol({
        slug: 'below-floor-cex',
        name: 'Small Exchange',
        category: 'CEX',
        tvl_usd: FLOOR - 1,
      }),
    ]),
  );

  assert.deepEqual(
    report.candidates.map((row) => row.slug),
    ['above-floor-mystery', 'below-floor-mystery'],
  );
  assert.ok(
    report.candidates.every((row) => row.reason === 'missing-token-metadata'),
  );
  assert.deepEqual(exclusionsOf(report, 'below-floor-cex'), ['cex-category']);
});

test('reconciles, sorts, and freezes every partition and nested value', () => {
  const input = doc(
    [
      protocol({
        slug: 'peer',
        name: 'Peer',
        symbol: 'PEER',
        gecko_id: 'peer',
        mcap_usd: 1_000,
        chains: ['Ethereum'],
      }),
      protocol({ slug: 'watch', name: 'Watch', category: null }),
      protocol({
        slug: 'overlay',
        name: 'Coinbase Staked Ether',
        category: 'Liquid Staking',
      }),
      protocol({
        slug: 'wrapped',
        name: 'Wrapped Thing',
        symbol: 'wTHING',
        mcap_usd: 100,
      }),
      protocol({ slug: 'below', name: 'Below', tvl_usd: FLOOR - 1 }),
    ],
    ['watch'],
  );

  const report = adaptSnapshot(input);

  assert.equal(report.ledger.length, 5);
  assert.equal(report.candidates.length, 2);
  assert.equal(report.peers.length, 1);
  assert.equal(report.excluded.length, 2);
  assert.equal(
    report.candidates.length + report.peers.length + report.excluded.length,
    report.ledger.length,
  );
  assert.equal(new Set(report.ledger.map((row) => row.slug)).size, 5);

  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.ledger));
  assert.ok(Object.isFrozen(report.candidates));
  assert.ok(Object.isFrozen(report.peers));
  assert.ok(Object.isFrozen(report.excluded));
  assert.ok(report.ledger.every((row) => Object.isFrozen(row)));
  assert.ok(report.ledger.every((row) => Object.isFrozen(row.flags)));
  assert.ok(report.ledger.every((row) => Object.isFrozen(row.exclusions)));
  assert.ok(report.ledger.every((row) => Object.isFrozen(row.token)));
  assert.ok(report.ledger.every((row) => Object.isFrozen(row.token.chains)));

  assert.throws(() => {
    (report.ledger as unknown as SnapshotLedgerRow[]).push(onlyRow(report.peers));
  }, TypeError);
});

test('returns empty reconciled partitions for an empty document', () => {
  const report = adaptSnapshot(doc([]));
  assert.deepEqual(report.ledger, []);
  assert.deepEqual(report.candidates, []);
  assert.deepEqual(report.peers, []);
  assert.deepEqual(report.excluded, []);
  assert.equal(report.asOf, AS_OF);
  assert.equal(report.floorUsd, FLOOR);
});

const REAL_SNAPSHOT_SHA256 =
  '42a71213519479f3a180cc5010cbbf6bd18a2447fa0ad29e4c5122b6c9184393';
const realSnapshotPath =
  process.env.TOKEN_RADAR_SNAPSHOT ??
  'D:/hermes/cache/scratch/token-radar-snapshot/snapshot.json';
const realSnapshotAvailable = existsSync(realSnapshotPath);

test(
  'adapts the verified real snapshot with exact reconciliation',
  { skip: !realSnapshotAvailable },
  () => {
    const bytes = readFileSync(realSnapshotPath);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      REAL_SNAPSHOT_SHA256,
      'scratch snapshot does not match the kit manifest hash',
    );

    const parsedJson: unknown = JSON.parse(bytes.toString('utf8'));
    const report = adaptSnapshot(parsedJson);
    const raw = parsedJson as {
      protocols: unknown[];
      watchlist: string[];
    };

    assert.equal(report.asOf, '2026-11-14');
    assert.equal(
      report.source,
      'DefiLlama https://api.llama.fi/protocols, fetched 2026-11-14T01:18:33.201Z',
    );
    assert.equal(report.floorUsd, 50_000_000);

    assert.equal(raw.protocols.length, 758);
    assert.equal(raw.watchlist.length, 40);
    assert.equal(report.ledger.length, 758);
    assert.equal(report.candidates.length, 198);
    assert.equal(report.peers.length, 127);
    assert.equal(report.excluded.length, 433);
    assert.equal(
      report.candidates.length + report.peers.length + report.excluded.length,
      report.ledger.length,
    );

    const watched = report.candidates.filter(
      (row) => row.reason === 'watchlist' && row.token.watchlist === true,
    );
    assert.equal(watched.length, 40);
    assert.deepEqual(
      watched.map((row) => row.slug).sort(),
      [...raw.watchlist].sort(),
    );
    assert.ok(watched.every((row) => row.exclusions.length === 0));

    const overlaid = report.ledger.filter((row) => row.exclusions.length > 0);
    assert.equal(overlaid.length, 133);
    assert.ok(
      overlaid.every(
        (row) => row.status === 'excluded' && row.token.watchlist !== true,
      ),
    );
    assert.equal(
      overlaid.filter((row) =>
        row.exclusions.includes('bridged-category'),
      ).length,
      43,
    );
    assert.equal(
      overlaid.filter((row) =>
        row.exclusions.includes('cex-category'),
      ).length,
      42,
    );
    assert.equal(
      overlaid.filter((row) =>
        row.exclusions.includes('liquid-staking-category'),
      ).length,
      38,
    );
    assert.equal(
      overlaid.filter((row) =>
        row.exclusions.includes('liquid-restaking-category'),
      ).length,
      3,
    );
    assert.equal(
      overlaid.filter((row) =>
        row.exclusions.includes('restaked-btc-category'),
      ).length,
      2,
    );
    assert.equal(
      overlaid.filter((row) =>
        row.exclusions.includes('wrapped-or-staked-name'),
      ).length,
      20,
    );
    assert.equal(
      overlaid.filter((row) =>
        row.exclusions.includes('exchange-branded-name'),
      ).length,
      14,
    );

    const belowFloorCandidates = report.candidates.filter(
      (row) =>
        row.reason === 'missing-token-metadata' &&
        (row.token.tvlUsd ?? 0) < report.floorUsd,
    );
    assert.equal(belowFloorCandidates.length, 138);
    assert.equal(
      report.candidates.filter(
        (row) =>
          row.reason === 'missing-token-metadata' &&
          (row.token.tvlUsd ?? 0) >= report.floorUsd,
      ).length,
      20,
    );

    assert.ok(Object.isFrozen(report.candidates));
    assert.ok(
      report.ledger.every((row) => row.slug === row.token.slug),
    );
  },
);

test(
  'rejects the real snapshot if its manifest hash is not the verified one',
  { skip: !realSnapshotAvailable },
  () => {
    const bytes = readFileSync(realSnapshotPath);
    const actual = createHash('sha256').update(bytes).digest('hex');
    assert.equal(actual, REAL_SNAPSHOT_SHA256);
  },
);
