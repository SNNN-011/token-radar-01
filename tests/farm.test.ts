import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { buildFarmPlan } from '../lib/farm.ts';
import { adaptSnapshot } from '../lib/snapshot.ts';
import type { SnapshotLedgerRow } from '../lib/snapshot.ts';

const REAL_SNAPSHOT_SHA256 =
  '42a71213519479f3a180cc5010cbbf6bd18a2447fa0ad29e4c5122b6c9184393';
const realSnapshotPath =
  process.env.TOKEN_RADAR_SNAPSHOT ??
  'D:/hermes/cache/scratch/token-radar-snapshot/snapshot.json';
const realSnapshotSkip = existsSync(realSnapshotPath)
  ? false
  : `snapshot not found at ${realSnapshotPath}`;

const CATEGORIES = [
  'Anchor BTC',
  'Basis Trading',
  'CDP',
  'CDP Manager',
  'CeDeFi',
  'Chain',
  'Collateral Markets',
  'Crypto Card Issuer',
  'Decentralized BTC',
  'Derivatives',
  'Dexs',
  'Dual-Token Stablecoin',
  'Farm',
  'Governance Incentives',
  'Indexes',
  'Insurance',
  'Interest Rate Derivatives',
  'Lending',
  'Leveraged Farming',
  'Liquidity Manager',
  'OTC Marketplace',
  'Onchain Capital Allocator',
  'Payments',
  'Prediction Market',
  'RWA',
  'Restaking',
  'Risk Curators',
  'Stablecoin Wrapper',
  'Staking Pool',
  'Uncollateralized Lending',
  'Yield',
  'Yield Aggregator',
] as const;

function fixtureRow(
  slug: string,
  category: string | null,
  name = slug,
  chains: readonly string[] = ['Ethereum'],
): SnapshotLedgerRow {
  return {
    slug,
    status: 'candidate',
    reason: 'missing-token-metadata',
    coreReason: 'missing-token-metadata',
    flags: Object.freeze([]),
    token: Object.freeze({
      slug,
      name,
      category,
      chains: Object.freeze([...chains]),
      tvlUsd: 100_000_000,
      change7d: null,
      marketCapUsd: null,
      listedAt: null,
      geckoId: null,
      symbol: null,
      watchlist: false,
    }),
    exclusions: Object.freeze([]),
    advisories: Object.freeze([]),
  };
}

type FarmPlan = ReturnType<typeof buildFarmPlan>;

function assertLegalPlan(plan: FarmPlan, row: SnapshotLedgerRow): void {
  assert.ok(
    plan.status === 'source-backed' ||
      plan.status === 'verify-terms' ||
      plan.status === 'research-only',
    `${row.slug}: illegal status ${plan.status}`,
  );
  assert.ok(Object.isFrozen(plan), `${row.slug}: plan is not frozen`);
  assert.ok(Object.isFrozen(plan.steps), `${row.slug}: steps are not frozen`);
  assert.ok(Object.isFrozen(plan.sources), `${row.slug}: sources are not frozen`);
  assert.ok(
    plan.steps.length >= 3 && plan.steps.length <= 12,
    `${row.slug}: ${plan.steps.length} steps is outside 3..12`,
  );

  const seen = new Set<string>();
  for (const step of plan.steps) {
    assert.equal(typeof step, 'string');
    assert.equal(step, step.trim(), `${row.slug}: step has outer whitespace`);
    assert.ok(
      step.length >= 20 && step.length <= 600,
      `${row.slug}: step length ${step.length} is outside 20..600`,
    );
    assert.ok(!seen.has(step), `${row.slug}: duplicate step`);
    seen.add(step);
  }

  const text = plan.steps.join(' ').toLowerCase();
  for (const term of [
    'fee',
    'gas',
    'exit',
    'skip',
    'risk',
    'not zero',
    'not investment advice',
  ]) {
    assert.ok(text.includes(term), `${row.slug}: plan is missing "${term}"`);
  }
  assert.ok(!/https?:\/\//i.test(text), `${row.slug}: URL leaked into steps`);
  assert.ok(!/\bapy\b/i.test(text), `${row.slug}: plan states an APY`);
  if (row.slug !== 'onre') {
    assert.ok(!text.includes('%'), `${row.slug}: plan states an uncited percentage`);
  }

  for (const source of plan.sources) {
    assert.match(source, /^https:\/\/[^\s]+$/, `${row.slug}: non-URL source`);
    assert.ok(!source.endsWith('/'), `${row.slug}: source has trailing slash`);
  }

  assert.deepEqual(buildFarmPlan(row), plan, `${row.slug}: nondeterministic plan`);
}

test('unit: protocol-specific routes cite official docs and exact conditions', () => {
  const evidence = [
    {
      slug: 'steakhouse-financial',
      status: 'source-backed',
      keywords: ['prime instant', 'usdc', 'performance fee', 'morpho'],
      sources: [
        'https://steakhouse.financial/docs/products/vault-products/current/prime-instant',
        'https://steakhouse.financial/docs/risk-management/monitoring/vault-setup-and-controls',
      ],
    },
    {
      slug: 'gauntlet',
      status: 'source-backed',
      keywords: ['base usdc prime v2', 'gtusda', 'morpho', 'cross-chain'],
      sources: [
        'https://vaultbook.gauntlet.xyz/vaults/morpho-vaults/vault-fees',
        'https://vaultbook.gauntlet.xyz/vaults/morpho-vaults/morpho-vaults-overview',
      ],
    },
    {
      slug: 'veda',
      status: 'verify-terms',
      keywords: ['venue infrastructure', 'partner', 'queue', 'solver'],
      sources: [
        'https://docs.veda.tech/integrations/deposits-and-withdrawals-overview',
        'https://docs.veda.tech/api/vaults',
      ],
    },
    {
      slug: 'usdd',
      status: 'source-backed',
      keywords: ['usdd savings', 'tron cdp vault', 'depeg', 'bnb chain'],
      sources: [
        'https://docs.usdd.io/user-guide/usdd-savings',
        'https://docs.usdd.io/legals/terms-of-use',
      ],
    },
    {
      slug: 'onre',
      status: 'verify-terms',
      keywords: ['onyc', 'kyc', 'accredited', '2.5%', 'target'],
      sources: [
        'https://docs.onre.finance/for-capital-providers/redemptions',
        'https://docs.onre.finance/legal/kyc-and-aml-policy',
      ],
    },
    {
      slug: 'symbiotic',
      status: 'verify-terms',
      keywords: ['collateral vault', '[e,2e)', 'slash', 'points'],
      sources: [
        'https://docs.symbiotic.fi/learn/mechanics/epochs-and-delays',
        'https://docs.symbiotic.fi/get-started/resources/risks',
      ],
    },
    {
      slug: 'kpk',
      status: 'source-backed',
      keywords: ['usdc prime core', 'morpho', 'bad-debt', 'large-exit'],
      sources: [
        'https://docs.kpk.io/vaults/vaults/morpho/ethereum/usdc-prime-core',
        'https://docs.kpk.io/vaults/resources/legal/morpho-disclaimer',
      ],
    },
  ] as const;

  for (const entry of evidence) {
    const row = fixtureRow(entry.slug, 'Risk Curators');
    const plan = buildFarmPlan(row);
    assertLegalPlan(plan, row);
    assert.equal(plan.status, entry.status, `${entry.slug}: wrong status`);

    const text = plan.steps.join(' ').toLowerCase();
    for (const keyword of entry.keywords) {
      assert.ok(text.includes(keyword), `${entry.slug}: missing "${keyword}"`);
    }
    for (const source of entry.sources) {
      assert.ok(plan.sources.includes(source), `${entry.slug}: missing ${source}`);
    }
  }
});

test('unit: all candidate categories have distinct long-tail guidance', () => {
  const bodies = new Set<string>();

  for (const category of CATEGORIES) {
    const row = fixtureRow(
      `fixture-${category.toLowerCase().replaceAll(' ', '-')}`,
      category,
      `Fixture ${category}`,
      ['Ethereum', 'Base', 'Arbitrum', 'Optimism'],
    );
    const plan = buildFarmPlan(row);
    assertLegalPlan(plan, row);
    assert.ok(
      plan.status === 'verify-terms' || plan.status === 'research-only',
      `${category}: generic plan must not claim source-backed`,
    );

    const text = plan.steps.join(' ').toLowerCase();
    assert.ok(
      !text.includes('category is unknown or unlisted'),
      `${category}: fell through to the unknown-category plan`,
    );
    bodies.add(plan.steps.slice(1, -1).join('\n'));
  }

  assert.equal(
    bodies.size,
    CATEGORIES.length,
    'category profiles are not meaningfully distinct',
  );
});

test('unit: unknown categories and non-candidate rows fail closed', () => {
  const unknown = fixtureRow('mystery-protocol', 'Mystery Category', 'Mystery');
  const unknownPlan = buildFarmPlan(unknown);
  assertLegalPlan(unknownPlan, unknown);
  assert.equal(unknownPlan.status, 'research-only');
  assert.match(unknownPlan.steps.join(' '), /unknown or unlisted/i);

  const peer: SnapshotLedgerRow = {
    ...fixtureRow('peer-protocol', 'Lending', 'Peer Protocol'),
    status: 'peer',
    reason: 'peer',
    coreReason: 'peer',
  };
  const peerPlan = buildFarmPlan(peer);
  assertLegalPlan(peerPlan, peer);
  assert.equal(peerPlan.status, 'research-only');
  assert.equal(peerPlan.sources.length, 0);
});

test(
  'integration: all 197 candidates and exactly 40 watchlist rows get legal plans',
  { skip: realSnapshotSkip },
  () => {
    const bytes = readFileSync(realSnapshotPath);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      REAL_SNAPSHOT_SHA256,
      'snapshot does not match the verified hash',
    );

    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    const report = adaptSnapshot(parsed);
    assert.equal(report.candidates.length, 197);
    assert.equal(
      report.candidates.filter((row) => row.token.watchlist === true).length,
      40,
    );
    assert.equal(report.peers.length, 127);
    assert.equal(report.excluded.length, 434);

    for (const row of report.candidates) {
      assertLegalPlan(buildFarmPlan(row), row);
    }

    const watchlist = report.candidates.filter(
      (row) => row.token.watchlist === true,
    );
    assert.equal(new Set(watchlist.map((row) => row.slug)).size, 40);
    for (const row of watchlist) {
      assertLegalPlan(buildFarmPlan(row), row);
    }

    const statuses = new Set(
      report.candidates.map((row) => buildFarmPlan(row).status),
    );
    assert.deepEqual([...statuses].sort(), [
      'research-only',
      'source-backed',
      'verify-terms',
    ]);

    const categories = new Set(
      report.candidates.map((row) => row.token.category ?? '(unknown)'),
    );
    assert.equal(categories.size, 32);
  },
);
