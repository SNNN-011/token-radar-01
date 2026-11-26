import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  BOARD_MAX_BYTES,
  MAX_IMPLIED_USD,
  assemble,
  buildBoard,
  dataScript,
} from '../lib/entry.ts';
import type {
  EntryData,
  EntryRow,
  FarmPlan,
  FarmPlanner,
} from '../lib/entry.ts';
import { adaptSnapshot } from '../lib/snapshot.ts';
import type {
  SnapshotLedgerRow,
  SnapshotReason,
  SnapshotReport,
} from '../lib/snapshot.ts';
import { benchmarkValuation } from '../lib/evaluation.ts';
import type { ValuationBenchmark } from '../lib/evaluation.ts';
import type {
  TokenValuation,
  ValuationEvidenceFlag,
} from '../lib/valuation.ts';
import type {
  LedgerFlag,
  LedgerStatus,
  NormalizedToken,
} from '../lib/universe.ts';
import {
  ensureFreshOutputDir,
  loadDossierBuilder,
  loadFarmPlanner,
  parseCli,
  resolveInputPath,
  resolveOutputPath,
  runCli,
  scanDashboard,
  serializeBoard,
  writeDashboard,
} from '../main.ts';

const AS_OF = '2026-11-14';
const SOURCE =
  'DefiLlama https://api.llama.fi/protocols, fetched 2026-11-14T01:18:33.201Z';
const FLOOR = 50_000_000;

function makeToken(
  overrides: Partial<NormalizedToken> = {},
): NormalizedToken {
  return {
    slug: 'alpha',
    name: 'Alpha',
    category: 'Dexs',
    chains: ['Ethereum'],
    tvlUsd: 1_000_000,
    change7d: 1.5,
    marketCapUsd: null,
    listedAt: '2024-01-01',
    geckoId: null,
    symbol: null,
    watchlist: false,
    ...overrides,
  };
}

function makeRow(
  slug: string,
  status: LedgerStatus,
  reason: SnapshotReason,
  flags: readonly LedgerFlag[],
  tokenOverrides: Partial<NormalizedToken> = {},
): SnapshotLedgerRow {
  return {
    slug,
    status,
    reason,
    coreReason: reason,
    flags,
    token: makeToken({ slug, ...tokenOverrides }),
    exclusions: [],
    advisories: [],
  };
}

function peerExample(
  slug: string,
  tvlUsd: number,
  marketCapUsd: number,
) {
  return {
    slug,
    category: 'Dexs',
    tvlUsd,
    marketCapUsd,
    marketCapToTvlRatio: marketCapUsd / tvlUsd,
    sameCategory: true,
    logTvlDistance: 0.1,
  };
}

interface ValuationOptions {
  readonly implied: number;
  readonly low: number;
  readonly high: number;
  readonly watchlist?: boolean;
  readonly peerPoolN?: number;
  readonly flags?: readonly ValuationEvidenceFlag[];
}

function makeValuation(
  slug: string,
  options: ValuationOptions,
): TokenValuation {
  return {
    slug,
    category: 'Dexs',
    tvlUsd: 1_000_000,
    source: options.watchlist === true ? 'watchlist' : 'candidate',
    pointBasis: 'market-cap',
    impliedMarketCapUsd: options.implied,
    impliedLogMarketCap: Math.log(Math.max(options.implied, 1)),
    interval: {
      level: 0.8,
      lowUsd: options.low,
      highUsd: options.high,
      lowLog: Math.log(Math.max(options.low, 1)),
      highLog: Math.log(Math.max(options.high, 1)),
      widthLog: 1,
    },
    peerCategoryN: 1,
    peerPoolN: options.peerPoolN ?? 7,
    peerExamples: [peerExample('peer-a', 10_000, 20_000)],
    modelId: 'unit-test-model',
    evidenceFlags: options.flags ?? ['category-partially-pooled'],
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) / 2;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] as number;
  return (
    (sorted[lower] as number) +
    ((sorted[upper] as number) - (sorted[lower] as number)) *
      (position - lower)
  );
}

function modelEvaluation(
  residuals: readonly number[],
  signedOverride?: number,
): Record<string, unknown> {
  return {
    sampleN: residuals.length,
    medianAbsLogError: median(residuals.map(Math.abs)),
    coverage: 2 / 3,
    medianAbsolutePercentageError: 12.5,
    ...(signedOverride === undefined
      ? {}
      : { medianSignedLogError: signedOverride }),
    records: residuals.map((residualLog) => ({
      slug: 'record',
      actualLogMarketCap: 1,
      predictedLogMarketCap: 1,
      residualLog,
      intervalLowLog: 0,
      intervalHighLog: 2,
      intervalLogWidth: 2,
      insideInterval: true,
    })),
  };
}

function fixture(): {
  report: SnapshotReport;
  benchmark: ValuationBenchmark;
  callSlugs: string[];
  farm: FarmPlanner;
} {
  const zeta = makeRow(
    'zeta',
    'candidate',
    'watchlist',
    ['missing-token-metadata'],
    { name: 'Zeta', watchlist: true },
  );
  const alpha = makeRow(
    'alpha',
    'candidate',
    'watchlist',
    ['already-tokenized', 'missing-token-metadata'],
    {
      name: 'Alpha',
      watchlist: true,
      marketCapUsd: 10_000,
      geckoId: 'alpha',
      symbol: 'ALP',
    },
  );
  const beta = makeRow(
    'beta',
    'candidate',
    'missing-token-metadata',
    ['missing-token-metadata'],
    { name: 'Beta' },
  );
  const gamma = makeRow(
    'gamma',
    'candidate',
    'missing-token-metadata',
    ['missing-token-metadata'],
    { name: 'Gamma' },
  );
  const peer = makeRow('peer-one', 'peer', 'peer', [], {
    name: 'Peer One',
    marketCapUsd: 100_000,
    geckoId: 'peer-one',
    symbol: 'PEER',
  });
  const candidates = [zeta, alpha, beta, gamma];
  const ledger = [...candidates, peer];
  const report: SnapshotReport = {
    asOf: AS_OF,
    source: SOURCE,
    floorUsd: FLOOR,
    ledger,
    candidates,
    peers: [peer],
    excluded: [],
  };

  const valuations = [
    makeValuation('zeta', {
      implied: 50,
      low: 20,
      high: 80,
      watchlist: true,
      flags: ['sparse-category'],
    }),
    makeValuation('alpha', {
      implied: 50,
      low: 10,
      high: 100,
      watchlist: true,
      flags: ['category-partially-pooled'],
    }),
    makeValuation('beta', {
      implied: 200_000_000_000_000,
      low: 90_000_000_000_000,
      high: 300_000_000_000_000,
      flags: ['interval-wide'],
    }),
    makeValuation('gamma', {
      implied: 0.2,
      low: 0.1,
      high: 2,
      flags: ['category-unseen'],
    }),
  ];
  const benchmark = {
    asOf: AS_OF,
    holdout: {
      sampleN: 3,
      selected: modelEvaluation([0.1, 0.2, 0.9], 0.42),
      baseline: modelEvaluation([-1, 0, 1]),
      categoryBaseline: modelEvaluation([1, 2, 3]),
    },
    calibrationPool: { level: 0.8 },
    valuations,
  } as unknown as ValuationBenchmark;

  const callSlugs: string[] = [];
  const farm: FarmPlanner = (row) => {
    callSlugs.push(row.slug);
    return {
      status: 'verify-terms',
      steps: [
        `Confirm the official ${row.slug} product, chain and contract before any wallet action.`,
        'Read the official terms and quote every fee and gas amount; an unknown cost is not zero.',
        'Count approval, entry and exit in the round trip and confirm the queue or lock timing.',
        'Review smart-contract, liquidity and counterparty risk; no principal protection is assumed.',
      ],
      sources: [],
    };
  };

  return { report, benchmark, callSlugs, farm };
}

test('unit: assembles the compact contract, ranks ties by slug and falls back to ledger token status', () => {
  const { report, benchmark, farm, callSlugs } = fixture();
  const data = assemble(report, benchmark, farm);

  assert.deepEqual(data.counts, {
    protocols: 5,
    candidates: 4,
    watchlist: 2,
    peers: 1,
    excluded: 0,
  });
  assert.equal(data.asOf, AS_OF);
  assert.equal(data.source, SOURCE);
  assert.equal(data.rows.length, 4);
  assert.deepEqual(callSlugs.sort(), ['alpha', 'beta', 'gamma', 'zeta']);

  // Beta clamps to $100T; alpha and zeta tie at $50 and sort by exact slug;
  // gamma clamps up to the $1 floor.
  assert.deepEqual(
    data.rows.map((row) => [row.slug, row.rank, row.impliedValueUsd]),
    [
      ['beta', 1, MAX_IMPLIED_USD],
      ['alpha', 2, 50],
      ['zeta', 3, 50],
      ['gamma', 4, 1],
    ],
  );
  const alpha = data.rows.find((row) => row.slug === 'alpha') as EntryRow;
  assert.equal(alpha.watchlist, true);
  assert.equal(alpha.tokenStatus, 'already-tokenized');
  assert.deepEqual(alpha.flags, ['category-partially-pooled']);
  assert.equal(alpha.peerCount, 7);
  assert.deepEqual(alpha.peers, [
    { slug: 'peer-a', tvlUsd: 10_000, marketCapUsd: 20_000 },
  ]);
  assert.equal((data.rows.find((row) => row.slug === 'zeta') as EntryRow).tokenStatus, 'watchlist-unconfirmed');
  assert.equal((data.rows.find((row) => row.slug === 'beta') as EntryRow).tokenStatus, 'candidate');

  const beta = data.rows[0] as EntryRow;
  assert.equal(beta.lowUsd, 90_000_000_000_000);
  assert.equal(beta.highUsd, MAX_IMPLIED_USD);
  const gamma = data.rows[3] as EntryRow;
  assert.equal(gamma.lowUsd, 1);
  assert.equal(gamma.highUsd, 2);

  assert.deepEqual(data.benchmark.selected, {
    medianAbsLogError: 0.2,
    coverage: 2 / 3,
    medianAbsolutePercentageError: 12.5,
    medianSignedLogError: 0.42,
  });
  assert.equal(data.benchmark.global.medianSignedLogError, 0);
  assert.equal(data.benchmark.category.medianSignedLogError, 2);
  assert.equal(data.benchmark.sampleN, 3);
  assert.equal(data.benchmark.intervalLevel, 0.8);
  assert.match(data.benchmark.label, /held-out peer comparison/i);

  const again = assemble(report, benchmark, farm);
  assert.deepEqual(again, data);
});

test('unit: rejects invalid farm plans, missing valuations and wrong slugs', () => {
  const { report, benchmark, farm } = fixture();
  const badPlan = (plan: unknown): FarmPlanner =>
    () => plan as FarmPlan;

  assert.throws(
    () =>
      assemble(report, benchmark, badPlan({
        status: 'verify-terms',
        steps: ['only one step that is long enough to pass a naive check'],
        sources: [],
      })),
    /farm\.steps: expected 3 to 12 steps/,
  );
  assert.throws(
    () =>
      assemble(report, benchmark, badPlan({
        status: 'verify-terms',
        steps: Array.from({ length: 13 }, (_, index) =>
          `Step ${index} is long enough to satisfy the minimum length rule.`,
        ),
        sources: [],
      })),
    /farm\.steps: expected 3 to 12 steps/,
  );
  assert.throws(
    () =>
      assemble(report, benchmark, badPlan({
        status: 'verify-terms',
        steps: ['too short', 'This step is long enough to pass the length floor.', 'This step is also long enough to pass.'],
        sources: [],
      })),
    /farm\.steps\[0\]: expected 20 to 600 trimmed characters/,
  );
  assert.throws(
    () =>
      assemble(report, benchmark, badPlan({
        status: 'not-a-status',
        steps: [
          'This step is long enough to pass the length floor.',
          'This step is long enough to pass the length floor too.',
          'This step is long enough to pass the length floor as well.',
        ],
        sources: [],
      })),
    /farm\.status: expected a known farm plan status/,
  );

  const missing = {
    ...benchmark,
    valuations: (benchmark.valuations as readonly TokenValuation[]).slice(1),
  } as ValuationBenchmark;
  assert.throws(() => assemble(report, missing, farm), /no valuation for candidate slug\(s\): zeta/);

  const extra = {
    ...benchmark,
    valuations: [
      ...(benchmark.valuations as readonly TokenValuation[]),
      makeValuation('not-a-candidate', { implied: 1, low: 1, high: 1 }),
    ],
  } as ValuationBenchmark;
  assert.throws(
    () => assemble(report, extra, farm),
    /"not-a-candidate" is not a candidate/,
  );

  const duplicate = {
    ...benchmark,
    valuations: [
      ...(benchmark.valuations as readonly TokenValuation[]),
      makeValuation('alpha', { implied: 1, low: 1, high: 1 }),
    ],
  } as ValuationBenchmark;
  assert.throws(() => assemble(report, duplicate, farm), /duplicate valuation slug "alpha"/);
});

test('unit: data.js is a classic assignment that escapes script breakers and round-trips', () => {
  const maliciousName = 'Evil </script><script>alert(1)</script> & \u2028 \u2029';
  const candidate = makeRow(
    'evil',
    'candidate',
    'watchlist',
    ['missing-token-metadata'],
    { name: maliciousName, watchlist: true },
  );
  const peer = makeRow('peer-one', 'peer', 'peer', [], {
    name: 'Peer One',
    marketCapUsd: 100,
    geckoId: 'peer-one',
    symbol: 'PEER',
  });
  const report: SnapshotReport = {
    asOf: AS_OF,
    source: SOURCE,
    floorUsd: FLOOR,
    ledger: [candidate, peer],
    candidates: [candidate],
    peers: [peer],
    excluded: [],
  };
  const benchmark = {
    asOf: AS_OF,
    holdout: {
      sampleN: 2,
      selected: modelEvaluation([0.1, 0.2]),
      baseline: modelEvaluation([-0.2, 0.2]),
      categoryBaseline: modelEvaluation([0.1, 0.3]),
    },
    calibrationPool: { level: 0.8 },
    valuations: [makeValuation('evil', { implied: 10, low: 5, high: 20 })],
  } as unknown as ValuationBenchmark;
  const farm: FarmPlanner = (row) => ({
    status: 'research-only',
    steps: [
      `Confirm the official ${row.slug} route and contract before any wallet action.`,
      'Quote every fee and gas amount and count the full round trip in the checklist.',
      'Confirm the documented exit path and eligibility before committing capital.',
      'Review contract, liquidity and counterparty risk; no return is promised.',
    ],
    sources: [],
  });

  const data = assemble(report, benchmark, farm);
  const script = dataScript(data);
  assert.ok(script.startsWith('globalThis.TOKEN_RADAR_DATA = '));
  assert.ok(script.endsWith(';\n'));
  const payload = script.slice(
    'globalThis.TOKEN_RADAR_DATA = '.length,
    -2,
  );
  assert.ok(!/[<>&\u2028\u2029]/.test(payload));
  const parsed = JSON.parse(payload) as EntryData;
  assert.equal(parsed.rows[0]?.name, maliciousName);
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(data)));
});

test('unit: output safety refuses a non-empty directory without deleting it', () => {
  const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'token-radar-entry-'));
  try {
    const nonempty = join(base, 'nonempty');
    mkdirSync(nonempty);
    writeFileSync(join(nonempty, 'keep.txt'), 'keep me');
    assert.throws(() => ensureFreshOutputDir(nonempty), /is not empty/);
    assert.equal(readFileSync(join(nonempty, 'keep.txt'), 'utf8'), 'keep me');

    const empty = join(base, 'empty');
    mkdirSync(empty);
    ensureFreshOutputDir(empty);

    const missing = join(base, 'new', 'nested');
    ensureFreshOutputDir(missing);
    assert.ok(existsSync(missing));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('unit: dashboard preflight copies exact bytes and rejects missing or incomplete trees', () => {
  const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'token-radar-entry-'));
  try {
    const repo = join(base, 'repo');
    const dashboard = join(repo, 'dashboard');
    mkdirSync(dashboard, { recursive: true });
    writeFileSync(join(dashboard, 'index.html'), '<!doctype html><title>x</title>');
    writeFileSync(join(dashboard, 'app.css'), 'body{color:#111}');
    writeFileSync(join(dashboard, 'app.js'), 'globalThis.x = 1;');

    const source = scanDashboard(repo);
    assert.equal(source.files.length, 3);
    assert.equal(
      source.bytes,
      Buffer.byteLength('<!doctype html><title>x</title>') +
        Buffer.byteLength('body{color:#111}') +
        Buffer.byteLength('globalThis.x = 1;'),
    );
    const output = join(base, 'out');
    writeDashboard(source, output);
    assert.equal(
      readFileSync(join(output, 'dashboard', 'index.html'), 'utf8'),
      '<!doctype html><title>x</title>',
    );

    assert.throws(
      () => scanDashboard(join(base, 'missing')),
      /dashboard\/ is missing/,
    );
    const emptyDashboard = join(base, 'empty-repo', 'dashboard');
    mkdirSync(emptyDashboard, { recursive: true });
    assert.throws(
      () => scanDashboard(join(base, 'empty-repo')),
      /dashboard\/index\.html is missing/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('unit: pending farm and vendor modules fail clearly instead of falling back to a stub', async () => {
  const missing = (label: string): Promise<never> => {
    const error = new Error(`Cannot find module '${label}'`) as Error & {
      code: string;
    };
    error.code = 'ERR_MODULE_NOT_FOUND';
    return Promise.reject(error);
  };

  await assert.rejects(
    loadFarmPlanner(() => missing('./lib/farm.ts')),
    /lib\/farm\.ts is unavailable on this branch \(pending component\); merge/,
  );
  await assert.rejects(
    loadDossierBuilder(() => missing('./vendor/makefun-board.ts')),
    /vendor\/makefun-board\.ts is unavailable on this branch \(pending component\); merge/,
  );
  await assert.rejects(
    loadFarmPlanner(async () => ({})),
    /lib\/farm\.ts does not export buildFarmPlan/,
  );
  await assert.rejects(
    loadDossierBuilder(async () => ({ buildDossier: 'not-a-function' })),
    /vendor\/makefun-board\.ts does not export buildDossier/,
  );

  const planner: FarmPlanner = () => ({
    status: 'research-only',
    steps: ['a', 'b', 'c'],
    sources: [],
  });
  assert.equal(
    await loadFarmPlanner(async () => ({ buildFarmPlan: planner })),
    planner,
  );
  const builder = () => new Uint8Array([1, 2, 3]);
  assert.equal(
    await loadDossierBuilder(async () => ({ buildDossier: builder })),
    builder,
  );
});

test('unit: CLI input/output resolution and typo refusal are deterministic', () => {
  assert.deepEqual(parseCli(['--prepare', '--input', 'snap.json', '--output=out']), {
    prepare: true,
    input: 'snap.json',
    output: 'out',
    help: false,
  });
  assert.throws(() => parseCli(['--nope']), /unknown argument/);
  assert.throws(() => parseCli(['--input']), /--input needs a value/);
  assert.equal(
    resolveOutputPath(undefined, { MAKEFUN_OUTPUT_DIR: 'env-out' }),
    resolve('env-out'),
  );
  assert.equal(resolveOutputPath('cli-out', { MAKEFUN_OUTPUT_DIR: 'env-out' }), resolve('cli-out'));
  assert.equal(
    resolveInputPath(undefined, { MAKEFUN_INPUT_DIR: 'env-in' }),
    join(resolve('env-in'), 'snapshot.json'),
  );
});

// ---------------------------------------------------------------- integration

const REAL_SNAPSHOT_SHA256 =
  '42a71213519479f3a180cc5010cbbf6bd18a2447fa0ad29e4c5122b6c9184393';
const realSnapshotPath = process.env.TOKEN_RADAR_SNAPSHOT;
const requireRealSnapshot = process.env.TOKEN_RADAR_REQUIRE_SNAPSHOT === '1';

if (
  requireRealSnapshot &&
  (realSnapshotPath === undefined || realSnapshotPath.length === 0)
) {
  throw new Error(
    'TOKEN_RADAR_REQUIRE_SNAPSHOT=1 requires TOKEN_RADAR_SNAPSHOT to name the hash-verified snapshot file',
  );
}
if (
  requireRealSnapshot &&
  realSnapshotPath !== undefined &&
  realSnapshotPath.length > 0 &&
  !existsSync(realSnapshotPath)
) {
  throw new Error(
    `TOKEN_RADAR_REQUIRE_SNAPSHOT=1: hash-verified snapshot not found at ${realSnapshotPath}`,
  );
}
const realSnapshotSkip =
  realSnapshotPath === undefined || realSnapshotPath.length === 0
    ? 'TOKEN_RADAR_SNAPSHOT is not set'
    : !existsSync(realSnapshotPath)
      ? `snapshot not found at ${realSnapshotPath}`
      : false;

test(
  'integration: assembles the official snapshot with an explicit stub farm and covers 40/40 watchlist rows',
  { skip: realSnapshotSkip },
  () => {
    if (realSnapshotPath === undefined || realSnapshotPath.length === 0) {
      throw new Error('integration test ran without TOKEN_RADAR_SNAPSHOT');
    }
    const bytes = readFileSync(realSnapshotPath);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      REAL_SNAPSHOT_SHA256,
      'scratch snapshot does not match the kit manifest hash',
    );
    const raw = JSON.parse(bytes.toString('utf8')) as {
      as_of: string;
      source: string;
      protocols: unknown[];
      watchlist: string[];
    };
    const report = adaptSnapshot(raw);
    const benchmark = benchmarkValuation(report);

    const farmCalls: string[] = [];
    const stubFarm: FarmPlanner = (row) => {
      farmCalls.push(row.slug);
      const chains = Array.isArray(row.token.chains)
        ? row.token.chains.slice(0, 3).join(', ')
        : 'the listed chain';
      return {
        status: 'verify-terms',
        steps: [
          `Confirm the official ${row.slug} product, chain and contract on ${chains} before any wallet action.`,
          'Read the official terms and quote every fee and gas amount; an unknown cost is not zero.',
          'Count approval, entry and exit in the round trip and confirm any queue or lock timing.',
          'Review smart-contract, liquidity and counterparty risk; no principal protection is assumed.',
          'Skip the route if official terms, eligibility or the exit path cannot be verified.',
        ],
        sources: [],
      };
    };

    const data = assemble(report, benchmark, stubFarm);
    assert.deepEqual(data.counts, {
      protocols: raw.protocols.length,
      candidates: 197,
      watchlist: 40,
      peers: 127,
      excluded: 434,
    });
    assert.equal(data.counts.protocols, 758);
    assert.equal(data.asOf, raw.as_of);
    assert.equal(data.source, raw.source);
    assert.equal(data.rows.length, 197);
    assert.equal(farmCalls.length, 197);
    assert.equal(new Set(farmCalls).size, 197);

    const candidateBySlug = new Map(
      report.candidates.map((row) => [row.slug, row]),
    );
    const valuationBySlug = new Map(
      benchmark.valuations.map((valuation) => [valuation.slug, valuation]),
    );
    const rowBySlug = new Map(data.rows.map((row) => [row.slug, row]));

    assert.equal(rowBySlug.size, data.rows.length);
    assert.equal(data.rows[0]?.rank, 1);
    assert.equal(data.rows[196]?.rank, 197);
    for (let index = 0; index < data.rows.length; index += 1) {
      const row = data.rows[index] as EntryRow;
      const candidate = candidateBySlug.get(row.slug);
      const valuation = valuationBySlug.get(row.slug);
      assert.ok(candidate, `missing candidate ${row.slug}`);
      assert.ok(valuation, `missing valuation ${row.slug}`);
      assert.equal(row.rank, index + 1);
      assert.equal(row.slug, candidate.slug);
      assert.equal(row.name, candidate.token.name);
      assert.equal(row.category, candidate.token.category);
      assert.deepEqual(row.chains, candidate.token.chains);
      assert.equal(row.tvlUsd, candidate.token.tvlUsd);
      assert.equal(row.change7d, candidate.token.change7d);
      assert.equal(row.listedAt, candidate.token.listedAt);
      assert.equal(row.watchlist, candidate.token.watchlist === true);
      assert.equal(row.impliedValueUsd, Math.round(valuation.impliedMarketCapUsd));
      assert.ok(Number.isSafeInteger(row.impliedValueUsd));
      assert.ok(row.impliedValueUsd >= 1);
      assert.ok(row.impliedValueUsd <= MAX_IMPLIED_USD);
      assert.ok(row.lowUsd >= 1 && row.lowUsd <= row.impliedValueUsd);
      assert.ok(row.highUsd >= row.impliedValueUsd && row.highUsd <= MAX_IMPLIED_USD);
      assert.equal(row.peerCount, valuation.peerPoolN);
      assert.equal(row.peers.length, valuation.peerExamples.length);
      for (const peer of row.peers) {
        assert.deepEqual(Object.keys(peer).sort(), [
          'marketCapUsd',
          'slug',
          'tvlUsd',
        ]);
      }
      assert.deepEqual(row.flags, valuation.evidenceFlags);
      assert.equal(row.farm.steps.length, 5);
      assert.ok(row.farm.steps.every((step) => {
        const length = step.trim().length;
        return length >= 20 && length <= 600;
      }));
      if (index > 0) {
        const previous = data.rows[index - 1] as EntryRow;
        assert.ok(previous.impliedValueUsd >= row.impliedValueUsd);
      }
    }

    const watchlistRows = data.rows.filter((row) => row.watchlist);
    assert.equal(watchlistRows.length, raw.watchlist.length);
    assert.equal(watchlistRows.length, 40);
    const rowSlugs = new Set(data.rows.map((row) => row.slug));
    for (const slug of raw.watchlist) {
      assert.ok(rowSlugs.has(slug), `watchlist slug ${slug} is missing from rows`);
    }
    const statusCounts: Record<string, number> = {};
    for (const row of data.rows) {
      statusCounts[row.tokenStatus] = (statusCounts[row.tokenStatus] ?? 0) + 1;
    }
    assert.deepEqual(statusCounts, {
      'watchlist-unconfirmed': 40,
      candidate: 157,
    });
    assert.equal(data.benchmark.sampleN, benchmark.holdout.sampleN);
    assert.equal(data.benchmark.sampleN, 38);
    assert.equal(data.benchmark.intervalLevel, 0.8);
    assert.equal(
      data.benchmark.selected.medianSignedLogError,
      median(benchmark.holdout.selected.records.map((record) => record.residualLog)),
    );
    assert.ok(Number.isFinite(data.benchmark.selected.medianAbsLogError));
    assert.ok(Number.isFinite(data.benchmark.selected.coverage));
    assert.ok(Number.isFinite(data.benchmark.selected.medianAbsolutePercentageError));

    const board = buildBoard(data, report);
    assert.equal(board.length, 197);
    assert.deepEqual(Object.keys(board[0] as object), [
      'slug',
      'name',
      'rank',
      'implied_value_usd',
      'farm_steps',
    ]);
    for (let index = 0; index < board.length; index += 1) {
      const row = board[index]!;
      assert.equal(row.rank, index + 1);
      assert.equal(row.slug, data.rows[index]?.slug);
      assert.equal(row.name, data.rows[index]?.name);
      assert.equal(row.implied_value_usd, data.rows[index]?.impliedValueUsd);
      assert.deepEqual(row.farm_steps, data.rows[index]?.farm.steps);
    }
    const boardText = serializeBoard(board);
    assert.ok(Buffer.byteLength(boardText, 'utf8') <= BOARD_MAX_BYTES);

    const script = dataScript(data);
    assert.ok(script.startsWith('globalThis.TOKEN_RADAR_DATA = '));
    assert.ok(script.endsWith(';\n'));
    const payload = script.slice(
      'globalThis.TOKEN_RADAR_DATA = '.length,
      -2,
    );
    assert.ok(!/[<>&\u2028\u2029]/.test(payload));
    const parsed = JSON.parse(payload) as EntryData;
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(data)));
    const serialized = JSON.stringify(data);
    for (const rawField of [
      '"holdout"',
      '"modelSelection"',
      '"records"',
      '"peerExamples"',
      '"modelId"',
      '"seed"',
      '"targetSlugs"',
    ]) {
      assert.ok(
        !serialized.includes(rawField),
        `raw benchmark field ${rawField} leaked into the public data`,
      );
    }

    const again = assemble(report, benchmark, stubFarm);
    assert.deepEqual(again, data);
    assert.equal(dataScript(again), script);
    assert.deepEqual(buildBoard(again, report), board);
  },
);

test(
  'integration: --prepare writes board, data and dashboard but never fabricates screenshots or a dossier',
  { skip: realSnapshotSkip },
  async () => {
    if (realSnapshotPath === undefined || realSnapshotPath.length === 0) {
      throw new Error('prepare integration test ran without TOKEN_RADAR_SNAPSHOT');
    }
    const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'token-radar-entry-'));
    try {
      const repo = join(base, 'repo');
      const dashboard = join(repo, 'dashboard');
      mkdirSync(dashboard, { recursive: true });
      writeFileSync(join(dashboard, 'index.html'), '<!doctype html><title>fixture</title>');
      writeFileSync(join(dashboard, 'app.css'), 'body{color:#111}');
      writeFileSync(join(dashboard, 'app.js'), 'globalThis.fixture = true;');

      const output = join(base, 'out');
      const planner: FarmPlanner = (row) => ({
        status: 'verify-terms',
        steps: [
          `Confirm the official ${row.slug} product, chain and contract before any wallet action.`,
          'Read the official terms and quote every fee and gas amount; an unknown cost is not zero.',
          'Count approval, entry and exit in the round trip and confirm any queue or lock timing.',
          'Review smart-contract, liquidity and counterparty risk; no principal protection is assumed.',
          'Skip the route if official terms, eligibility or the exit path cannot be verified.',
        ],
        sources: [],
      });
      const code = await runCli({
        argv: ['--prepare', '--input', realSnapshotPath, '--output', output],
        env: {},
        repoRoot: repo,
        farmLoader: async () => ({ buildFarmPlan: planner }),
      });
      assert.equal(code, 0);

      const board = JSON.parse(
        readFileSync(join(output, 'board.json'), 'utf8'),
      ) as { rows: readonly unknown[] };
      assert.equal(board.rows.length, 197);
      const script = readFileSync(join(output, 'data.js'), 'utf8');
      assert.ok(script.startsWith('globalThis.TOKEN_RADAR_DATA = '));
      const payload = script.slice(
        'globalThis.TOKEN_RADAR_DATA = '.length,
        -2,
      );
      const data = JSON.parse(payload) as EntryData;
      assert.equal(data.rows.length, 197);
      assert.equal(
        readFileSync(join(output, 'dashboard', 'index.html'), 'utf8'),
        '<!doctype html><title>fixture</title>',
      );
      assert.equal(existsSync(join(output, 'screenshots')), false);
      assert.equal(existsSync(join(output, 'dossier.json')), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);
