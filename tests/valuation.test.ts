import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { adaptSnapshot } from '../lib/snapshot.ts';
import {
  DEFAULT_VALUATION_OPTIONS,
  ValuationInputError,
  ValuationOptionsError,
  fitValuationModel,
  predictLogMarketCap,
  prepareValuationPeers,
  splitValuationPeers,
  valueCandidates,
  valueToken,
} from '../lib/valuation.ts';
import type {
  IntervalCalibration,
  ValuationModelSpec,
  ValuationOptions,
  ValuationPeer,
} from '../lib/valuation.ts';
import {
  benchmarkValuation,
  buildCandidateSpecs,
  calibrateValuationModel,
  evaluateValuationModel,
  selectValuationModel,
  toDossierSummary,
} from '../lib/evaluation.ts';
import type {
  DossierSummary,
  ModelEvaluation,
  ValuationBenchmark,
} from '../lib/evaluation.ts';

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
): Record<string, unknown> {
  return {
    as_of: AS_OF,
    source: SOURCE,
    floor_usd: FLOOR,
    protocols,
    watchlist,
  };
}

function peer(
  overrides: Partial<ValuationPeer> & { slug: string },
): ValuationPeer {
  return {
    slug: overrides.slug,
    category: 'Dexs',
    tvlUsd: 100,
    marketCapUsd: 200,
    change7d: 0,
    ageDays: 365,
    ...overrides,
  };
}

function peers(count: number, prefix = 'peer'): ValuationPeer[] {
  const source = Array.from({ length: count }, (_, index) =>
    peer({
      slug: `${prefix}-${String(index).padStart(3, '0')}`,
      category: index % 2 === 0 ? 'Dexs' : 'Lending',
      tvlUsd: 100 + index,
      marketCapUsd: 200 + index * 10,
    }),
  );
  return source;
}

function options(
  overrides: Partial<ValuationOptions> = {},
): ValuationOptions {
  return { ...DEFAULT_VALUATION_OPTIONS, ...overrides };
}

function daysBetween(start: string, end: string): number {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  return Math.round((endMs - startMs) / 86_400_000);
}

function assertDeepFrozen(value: unknown): void {
  if (Array.isArray(value)) {
    assert.ok(Object.isFrozen(value));
    value.forEach(assertDeepFrozen);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    assert.ok(Object.isFrozen(value));
    Object.values(value).forEach(assertDeepFrozen);
  }
}

test('prepareValuationPeers keeps only tokenized peers with positive scale', () => {
  const report = adaptSnapshot(
    doc(
      [
        protocol({
          slug: 'peer-a',
          name: 'Peer A',
          category: 'Dexs',
          tvl_usd: 1_000,
          mcap_usd: 2_000,
          listed_at: '2025-01-01',
          change_7d: 3.5,
        }),
        protocol({
          slug: 'peer-b',
          name: 'Peer B',
          category: 'Lending',
          tvl_usd: 2_000,
          mcap_usd: 1_000,
          listed_at: null,
          change_7d: null,
        }),
        protocol({
          slug: 'watch-candidate',
          name: 'Watch Candidate',
          category: 'Dexs',
          tvl_usd: 500,
          mcap_usd: null,
        }),
        protocol({
          slug: 'wrapped-excluded',
          name: 'Wrapped Thing',
          category: 'Dexs',
          tvl_usd: 500,
          mcap_usd: 900,
        }),
      ],
      ['watch-candidate'],
    ),
  );

  const prepared = prepareValuationPeers(report);
  assert.deepEqual(
    prepared.map((entry) => entry.slug),
    ['peer-a', 'peer-b'],
  );
  assert.deepEqual(prepared[0], {
    slug: 'peer-a',
    category: 'Dexs',
    tvlUsd: 1_000,
    marketCapUsd: 2_000,
    change7d: 3.5,
    ageDays: daysBetween('2025-01-01', AS_OF),
  });
  assert.equal(prepared[1]?.ageDays, null);
  assert.equal(prepared[1]?.change7d, null);
  assertDeepFrozen(prepared);
});

test('prepareValuationPeers rejects peers without a usable market-cap-to-TVL scale', () => {
  const report = adaptSnapshot(
    doc([
      protocol({
        slug: 'zero-tvl-peer',
        name: 'Zero TVL',
        tvl_usd: 0,
        mcap_usd: 1_000,
      }),
    ]),
  );

  assert.throws(
    () => prepareValuationPeers(report),
    (error: unknown) => {
      assert.ok(error instanceof ValuationInputError);
      assert.match(error.message, /zero-tvl-peer/);
      assert.match(error.message, /tvlUsd/);
      return true;
    },
  );
});

test('splitValuationPeers is order-independent, exact and disjoint', () => {
  const source = peers(20);
  const first = splitValuationPeers(source, options());
  const second = splitValuationPeers([...source].reverse(), options());

  assert.deepEqual(first, second);
  assert.equal(first.train.length + first.holdout.length, 20);
  assert.equal(first.holdout.length, 6);
  assert.equal(first.train.length, 14);
  assert.deepEqual(
    first.trainSlugs,
    first.train.map((entry) => entry.slug),
  );
  assert.deepEqual(
    first.holdoutSlugs,
    first.holdout.map((entry) => entry.slug),
  );

  const trainSlugs = new Set(first.trainSlugs);
  assert.ok(first.holdoutSlugs.every((slug) => !trainSlugs.has(slug)));
  assert.deepEqual(
    [...first.trainSlugs, ...first.holdoutSlugs].sort(),
    source.map((entry) => entry.slug).sort(),
  );
  assert.ok(
    first.train.every(
      (entry, index) =>
        index === 0 || (first.train[index - 1]?.slug as string) < entry.slug,
    ),
  );
  assert.ok(
    first.holdout.every(
      (entry, index) =>
        index === 0 || (first.holdout[index - 1]?.slug as string) < entry.slug,
    ),
  );
});

test('splitValuationPeers uses a stable seed-labelled slug hash', () => {
  const source = peers(20);
  const first = splitValuationPeers(source, options({ seed: 'seed-one' }));
  const same = splitValuationPeers(source, options({ seed: 'seed-one' }));
  const other = splitValuationPeers(source, options({ seed: 'seed-two' }));

  assert.deepEqual(first, same);
  assert.notDeepEqual(first.holdoutSlugs, other.holdoutSlugs);

  const expectedOrder = source
    .map((entry) => ({
      slug: entry.slug,
      key: createHash('sha256')
        .update(`seed-one\u0000split\u0000${entry.slug}`)
        .digest('hex'),
    }))
    .sort((left, right) =>
      left.key === right.key
        ? left.slug < right.slug
          ? -1
          : left.slug > right.slug
            ? 1
            : 0
        : left.key < right.key
          ? -1
          : 1,
    )
    .slice(0, 6)
    .map((entry) => entry.slug)
    .sort();

  assert.deepEqual([...first.holdoutSlugs].sort(), expectedOrder);
});

test('splitValuationPeers rejects impossible fractions and tiny samples', () => {
  const source = peers(20);
  assert.throws(
    () => splitValuationPeers(source, options({ holdoutFraction: 0 })),
    ValuationOptionsError,
  );
  assert.throws(
    () => splitValuationPeers(source, options({ holdoutFraction: 1 })),
    ValuationOptionsError,
  );
  assert.throws(
    () => splitValuationPeers([peer({ slug: 'only' })], options()),
    ValuationInputError,
  );
  assert.throws(
    () => splitValuationPeers([], options()),
    ValuationInputError,
  );
});

test('ValuationOptions rejects malformed hyperparameters', () => {
  const source = peers(20);
  const badOptions: Partial<ValuationOptions>[] = [
    { seed: '' },
    { folds: 1 },
    { folds: 1.5 },
    { intervalLevel: 0 },
    { intervalLevel: 1 },
    { minCategoryN: 0 },
    { maxPeerExamples: 0 },
    { categoryShrinkageGrid: [] },
    { categoryShrinkageGrid: [-1] },
    { categoryShrinkageGrid: [Number.NaN] },
    { wideIntervalLogWidth: 0 },
    { selectionToleranceLog: -1 },
    { huberDelta: 0 },
    { huberMaxIterations: 0 },
    { huberTolerance: 0 },
    { changeCapPercent: 0 },
    { ageCapYears: 0 },
  ];

  badOptions.forEach((overrides) => {
    assert.throws(
      () => splitValuationPeers(source, options({ folds: 5, ...overrides })),
      ValuationOptionsError,
      JSON.stringify(overrides),
    );
  });
});

function modelSpec(
  overrides: Partial<ValuationModelSpec> & {
    id: string;
    kind: ValuationModelSpec['kind'];
  },
): ValuationModelSpec {
  return {
    fit: overrides.kind === 'scale-partially-pooled' ? 'ols' : null,
    features: [],
    categoryShrinkage: 0,
    minCategoryN: 3,
    ...overrides,
  };
}

test('global median ratio predicts market cap from peer market-cap-to-TVL', () => {
  const source = [
    peer({ slug: 'a', tvlUsd: 10, marketCapUsd: 10 }),
    peer({ slug: 'b', tvlUsd: 20, marketCapUsd: 40 }),
    peer({ slug: 'c', tvlUsd: 30, marketCapUsd: 120 }),
    peer({ slug: 'd', tvlUsd: 40, marketCapUsd: 320 }),
    peer({ slug: 'e', tvlUsd: 50, marketCapUsd: 800 }),
  ];

  const model = fitValuationModel(
    source,
    modelSpec({ id: 'global-median-ratio', kind: 'global-median-ratio' }),
    options(),
  );

  assert.equal(model.fitSampleN, 5);
  assert.deepEqual(model.fitSlugs, ['a', 'b', 'c', 'd', 'e']);
  assert.ok(Math.abs(model.globalMedianLogRatio - Math.log(4)) < 1e-12);
  assert.ok(Math.abs((model.coefficients[0] as number) - Math.log(4)) < 1e-12);
  assert.equal(model.coefficients[1], 1);
  assert.equal(model.iterations, 0);
  assert.equal(model.converged, true);
  assert.deepEqual(model.categoryStats, []);

  const logPrediction = predictLogMarketCap(model, {
    slug: 'target',
    category: 'Dexs',
    tvlUsd: 100,
    change7d: null,
    ageDays: null,
  });
  assert.ok(Math.abs(logPrediction - Math.log(400)) < 1e-12);
  assert.equal(Math.round(Math.exp(logPrediction)), 400);
  assertDeepFrozen(model);
});

test('category median ratio falls back globally when support is too small', () => {
  const source = [
    ...Array.from({ length: 5 }, (_, index) =>
      peer({
        slug: `dex-${index}`,
        category: 'Dexs',
        tvlUsd: 10 + index,
        marketCapUsd: (10 + index) * 2,
      }),
    ),
    ...Array.from({ length: 2 }, (_, index) =>
      peer({
        slug: `thin-${index}`,
        category: 'Thin',
        tvlUsd: 10 + index,
        marketCapUsd: (10 + index) * 10,
      }),
    ),
  ];

  const model = fitValuationModel(
    source,
    modelSpec({
      id: 'category-median-ratio',
      kind: 'category-median-ratio',
      minCategoryN: 3,
    }),
    options(),
  );

  const dex = model.categoryStats.find((entry) => entry.category === 'Dexs');
  const thin = model.categoryStats.find((entry) => entry.category === 'Thin');
  assert.ok(dex);
  assert.ok(thin);
  assert.equal(dex.n, 5);
  assert.ok(Math.abs((dex.medianLogRatio as number) - Math.log(2)) < 1e-12);
  assert.equal(dex.offsetLog, 0);
  assert.equal(thin.n, 2);
  assert.equal(thin.medianLogRatio, null);

  const predict = (category: string): number =>
    predictLogMarketCap(model, {
      slug: 'target',
      category,
      tvlUsd: 100,
      change7d: null,
      ageDays: null,
    });

  assert.ok(Math.abs(predict('Dexs') - Math.log(200)) < 1e-12);
  assert.ok(Math.abs(predict('Thin') - Math.log(200)) < 1e-12);
  assert.ok(Math.abs(predict('Unseen') - Math.log(200)) < 1e-12);
});

function scaleFixture(): ValuationPeer[] {
  return ['A', 'B'].flatMap((category) =>
    Array.from({ length: 6 }, (_, index) => {
      const logTvl = 1 + index * 0.5;
      const offset = category === 'A' ? 1 : -1;
      const logMcap = 8 + 0.5 * logTvl + offset;
      return peer({
        slug: `${category.toLowerCase()}-${index}`,
        category,
        tvlUsd: Math.exp(logTvl),
        marketCapUsd: Math.exp(logMcap),
        change7d: category === 'A' ? 10 : -10,
        ageDays: 365 + index * 30,
      });
    }),
  );
}

test('scale-aware model shrinks category residual medians toward zero', () => {
  const source = scaleFixture();
  const model = fitValuationModel(
    source,
    modelSpec({
      id: 'scale-pooled:ols:base:k2',
      kind: 'scale-partially-pooled',
      fit: 'ols',
      categoryShrinkage: 2,
    }),
    options(),
  );

  assert.ok(Math.abs((model.coefficients[0] as number) - 8) < 1e-6);
  assert.ok(Math.abs((model.coefficients[1] as number) - 0.5) < 1e-6);
  assert.equal(model.iterations, 0);
  assert.equal(model.converged, true);

  const a = model.categoryStats.find((entry) => entry.category === 'A');
  const b = model.categoryStats.find((entry) => entry.category === 'B');
  assert.ok(a);
  assert.ok(b);
  assert.equal(a.n, 6);
  assert.equal(b.n, 6);
  assert.equal(a.supported, true);
  assert.equal(a.offsetApplied, true);
  assert.equal(a.belowMinCategoryN, false);
  assert.ok(Math.abs((a.residualMedianLog as number) - 1) < 1e-6);
  assert.ok(Math.abs((b.residualMedianLog as number) + 1) < 1e-6);
  assert.equal(a.weight, 0.75);
  assert.ok(Math.abs(a.offsetLog - 0.75) < 1e-6);
  assert.ok(Math.abs(b.offsetLog + 0.75) < 1e-6);

  const target = {
    slug: 'target',
    tvlUsd: Math.exp(3),
    change7d: 0,
    ageDays: 365,
  };
  const logA = predictLogMarketCap(model, { ...target, category: 'A' });
  const logB = predictLogMarketCap(model, { ...target, category: 'B' });
  const logUnseen = predictLogMarketCap(model, {
    ...target,
    category: 'Unseen',
  });
  assert.ok(Math.abs(logA - (8 + 1.5 + 0.75)) < 1e-6);
  assert.ok(Math.abs(logB - (8 + 1.5 - 0.75)) < 1e-6);
  assert.ok(Math.abs(logUnseen - (8 + 1.5)) < 1e-6);

  const heavy = fitValuationModel(
    source,
    modelSpec({
      id: 'scale-pooled:ols:base:k1000',
      kind: 'scale-partially-pooled',
      fit: 'ols',
      categoryShrinkage: 1000,
    }),
    options(),
  );
  const heavyA = heavy.categoryStats.find((entry) => entry.category === 'A');
  assert.ok(heavyA);
  assert.ok(Math.abs(heavyA.offsetLog) < 0.01);
});

test('scale model suppresses category offsets below minCategoryN', () => {
  const all = scaleFixture();
  const source = [
    ...all.filter((entry) => entry.category === 'A'),
    ...all.filter((entry) => entry.category === 'B').slice(0, 2),
  ];
  const model = fitValuationModel(
    source,
    modelSpec({
      id: 'scale-pooled:ols:base:k2',
      kind: 'scale-partially-pooled',
      fit: 'ols',
      categoryShrinkage: 2,
      minCategoryN: 3,
    }),
    options(),
  );
  const b = model.categoryStats.find((entry) => entry.category === 'B');
  assert.ok(b);
  assert.equal(b.n, 2);
  assert.equal(b.supported, false);
  assert.equal(b.belowMinCategoryN, true);
  assert.equal(b.offsetApplied, false);
  assert.equal(b.offsetLog, 0);
  assert.equal(b.weight, 0);
  assert.ok(Math.abs(b.residualMedianLog as number) > 0.01);

  const target = {
    slug: 'thin-target',
    category: 'B',
    tvlUsd: Math.exp(2),
    change7d: 0,
    ageDays: 365,
  };
  const globalPrediction =
    (model.coefficients[0] as number) +
    (model.coefficients[1] as number) * Math.log(target.tvlUsd);
  assert.ok(
    Math.abs(predictLogMarketCap(model, target) - globalPrediction) < 1e-12,
  );

  const valuation = valueToken(
    {
      ...target,
      watchlist: false,
    },
    model,
    source,
    calibrationFixture({
      sampleN: 40,
      lowerLogOffset: -0.1,
      upperLogOffset: 0.1,
    }),
    options(),
  );
  assert.ok(valuation.evidenceFlags.includes('sparse-category'));
  assert.ok(valuation.evidenceFlags.includes('category-offset-suppressed'));
});

test('scale-aware model supports capped change and age features without null leaks', () => {
  const source = scaleFixture().map((entry, index) => ({
    ...entry,
    change7d: index % 3 === 0 ? null : entry.change7d,
    ageDays: index % 4 === 0 ? null : entry.ageDays,
  }));

  const model = fitValuationModel(
    source,
    modelSpec({
      id: 'scale-pooled:ols:change7d+age:k0',
      kind: 'scale-partially-pooled',
      fit: 'ols',
      features: ['change7d', 'age'],
      categoryShrinkage: 0,
    }),
    options(),
  );

  assert.equal(model.coefficients.length, 4);
  assert.ok(model.coefficients.every((value) => Number.isFinite(value)));
  assert.ok(Number.isFinite(model.imputationMeans.changeUnits));
  assert.ok(Number.isFinite(model.imputationMeans.ageYears));

  const capped = predictLogMarketCap(model, {
    slug: 'capped',
    category: 'A',
    tvlUsd: Math.exp(3),
    change7d: 10_000,
    ageDays: 365 * 100,
  });
  const saturated = predictLogMarketCap(model, {
    slug: 'saturated',
    category: 'A',
    tvlUsd: Math.exp(3),
    change7d: options().changeCapPercent,
    ageDays: 365.25 * options().ageCapYears,
  });
  assert.ok(Math.abs(capped - saturated) < 1e-9);
});

test('Huber fit resists gross log-scale outliers and reports convergence', () => {
  const base = Array.from({ length: 24 }, (_, index) => {
    const logTvl = 1 + index * 0.2;
    return peer({
      slug: `clean-${index}`,
      category: null,
      tvlUsd: Math.exp(logTvl),
      marketCapUsd: Math.exp(8 + 0.5 * logTvl),
    });
  });
  const contaminated = [
    ...base,
    ...[2, 3, 4].map((index) => {
      const logTvl = 1 + index * 0.2;
      return peer({
        slug: `outlier-${index}`,
        category: null,
        tvlUsd: Math.exp(logTvl),
        marketCapUsd: Math.exp(8 + 0.5 * logTvl + 8),
      });
    }),
  ];

  const ols = fitValuationModel(
    contaminated,
    modelSpec({
      id: 'scale-pooled:ols:base:k0',
      kind: 'scale-partially-pooled',
      fit: 'ols',
    }),
    options(),
  );
  const huber = fitValuationModel(
    contaminated,
    modelSpec({
      id: 'scale-pooled:huber:base:k0',
      kind: 'scale-partially-pooled',
      fit: 'huber',
    }),
    options(),
  );

  const olsSlope = ols.coefficients[1] as number;
  const huberSlope = huber.coefficients[1] as number;
  assert.ok(huber.iterations > 1);
  assert.equal(huber.converged, true);
  assert.ok(
    Math.abs(huberSlope - 0.5) < Math.abs(olsSlope - 0.5),
    `huber slope ${huberSlope} should be closer to 0.5 than ols ${olsSlope}`,
  );

  const refit = fitValuationModel(
    contaminated,
    modelSpec({
      id: 'scale-pooled:huber:base:k0',
      kind: 'scale-partially-pooled',
      fit: 'huber',
    }),
    options(),
  );
  assert.deepEqual(huber, refit);
});

test('fitValuationModel rejects unusable prediction inputs', () => {
  const model = fitValuationModel(
    [peer({ slug: 'a' })],
    modelSpec({ id: 'global-median-ratio', kind: 'global-median-ratio' }),
    options(),
  );

  assert.throws(
    () =>
      predictLogMarketCap(model, {
        slug: 'zero',
        category: null,
        tvlUsd: 0,
        change7d: null,
        ageDays: null,
      }),
    ValuationInputError,
  );
  assert.throws(
    () =>
      predictLogMarketCap(model, {
        slug: 'negative',
        category: null,
        tvlUsd: -1,
        change7d: null,
        ageDays: null,
      }),
    ValuationInputError,
  );
  assert.throws(
    () => fitValuationModel([], model.spec, options()),
    ValuationInputError,
  );
});

function calibrationFixture(
  overrides: Partial<IntervalCalibration> = {},
): IntervalCalibration {
  return {
    level: 0.8,
    sampleN: 40,
    lowerLogOffset: -Math.log(2),
    upperLogOffset: Math.log(2),
    medianAbsLogError: 0.5,
    coverage: 0.79,
    ...overrides,
  };
}

function evaluationModel(): ReturnType<typeof fitValuationModel> {
  return fitValuationModel(
    [
      peer({ slug: 'p10', tvlUsd: 10, marketCapUsd: 40 }),
      peer({ slug: 'p20', tvlUsd: 20, marketCapUsd: 80 }),
      peer({ slug: 'p30', tvlUsd: 30, marketCapUsd: 120 }),
      peer({ slug: 'p40', tvlUsd: 40, marketCapUsd: 160 }),
      peer({ slug: 'p50', tvlUsd: 50, marketCapUsd: 200 }),
    ],
    modelSpec({ id: 'global-median-ratio', kind: 'global-median-ratio' }),
    options(),
  );
}

function actualPeers(): ValuationPeer[] {
  return [
    peer({ slug: 'a', tvlUsd: 10, marketCapUsd: 40 }),
    peer({ slug: 'b', tvlUsd: 10, marketCapUsd: 80 }),
    peer({ slug: 'c', tvlUsd: 10, marketCapUsd: 20 }),
    peer({ slug: 'd', tvlUsd: 10, marketCapUsd: 200 }),
    peer({ slug: 'e', tvlUsd: 10, marketCapUsd: 10 }),
  ];
}

test('calibration uses only out-of-fold residuals and is reproducible', () => {
  const source = peers(30);
  const calibration = calibrateValuationModel(
    source,
    modelSpec({ id: 'global-median-ratio', kind: 'global-median-ratio' }),
    options({ folds: 5 }),
  );

  assert.equal(calibration.sampleN, 30);
  assert.equal(calibration.level, 0.8);
  assert.ok(Number.isFinite(calibration.lowerLogOffset));
  assert.ok(Number.isFinite(calibration.upperLogOffset));
  assert.ok(calibration.lowerLogOffset <= calibration.upperLogOffset);
  assert.ok(
    calibration.coverage >= 0 && calibration.coverage <= 1,
    'coverage is observed, never forced to the nominal level',
  );
  assert.ok(Number.isFinite(calibration.medianAbsLogError));

  const again = calibrateValuationModel(
    source,
    modelSpec({ id: 'global-median-ratio', kind: 'global-median-ratio' }),
    options({ folds: 5 }),
  );
  assert.deepEqual(calibration, again);
  assertDeepFrozen(calibration);

  assert.throws(
    () =>
      calibrateValuationModel(
        [peer({ slug: 'single' })],
        modelSpec({ id: 'global-median-ratio', kind: 'global-median-ratio' }),
        options({ folds: 2 }),
      ),
    ValuationInputError,
  );
});

test('evaluateValuationModel reports log error, honest coverage and interval width', () => {
  const evaluation = evaluateValuationModel(
    evaluationModel(),
    calibrationFixture(),
    actualPeers(),
    options(),
  );

  assert.equal(evaluation.modelId, 'global-median-ratio');
  assert.equal(evaluation.sampleN, 5);
  assert.equal(evaluation.intervalLevel, 0.8);
  assert.ok(Math.abs(evaluation.medianAbsLogError - Math.log(2)) < 1e-12);
  assert.ok(
    Math.abs(evaluation.medianAbsolutePercentageError - 80) < 1e-9,
    'percentage error must divide by actual, not predicted',
  );
  assert.ok(Math.abs(evaluation.medianSignedLogError) < 1e-12);
  assert.ok(
    Math.abs(evaluation.meanSignedLogError - 0.044628710262841945) < 1e-12,
  );
  assert.ok(Math.abs(evaluation.coverage - 0.6) < 1e-12);
  assert.ok(
    Math.abs(evaluation.medianIntervalLogWidth - 2 * Math.log(2)) < 1e-12,
  );
  assert.equal(evaluation.records.length, 5);
  assert.deepEqual(
    evaluation.records.map((record) => record.slug),
    ['a', 'b', 'c', 'd', 'e'],
  );
  assert.deepEqual(
    evaluation.records.map((record) => record.insideInterval),
    [true, true, true, false, false],
  );
  assert.ok(
    evaluation.records.every(
      (record) =>
        Number.isFinite(record.residualLog) &&
        record.intervalLowLog <= record.intervalHighLog,
    ),
  );
  assertDeepFrozen(evaluation);
});

test('evaluation segments sum to the sample and retain small-n tails', () => {
  const source = [
    peer({ slug: 'q10', tvlUsd: 10, marketCapUsd: 40, category: 'Dexs' }),
    peer({ slug: 'q20', tvlUsd: 20, marketCapUsd: 80, category: 'Dexs' }),
    peer({ slug: 'q30', tvlUsd: 30, marketCapUsd: 120, category: 'Thin' }),
    peer({ slug: 'q40', tvlUsd: 40, marketCapUsd: 160, category: 'Thin' }),
    peer({ slug: 'q50', tvlUsd: 50, marketCapUsd: 200, category: 'Solo' }),
  ];
  const model = fitValuationModel(
    source,
    modelSpec({ id: 'global-median-ratio', kind: 'global-median-ratio' }),
    options(),
  );
  const targets = [
    peer({ slug: 't10', tvlUsd: 10, marketCapUsd: 40, category: 'Dexs' }),
    peer({ slug: 't20', tvlUsd: 20, marketCapUsd: 80, category: 'Dexs' }),
    peer({ slug: 't30', tvlUsd: 30, marketCapUsd: 120, category: 'Thin' }),
    peer({ slug: 't40', tvlUsd: 40, marketCapUsd: 160, category: 'Thin' }),
    peer({ slug: 't50', tvlUsd: 50, marketCapUsd: 200, category: 'Solo' }),
  ];

  const evaluation = evaluateValuationModel(
    model,
    calibrationFixture(),
    targets,
    options(),
  );
  const bySegment = new Map(
    evaluation.segments.map((segment) => [segment.segment, segment]),
  );

  assert.equal(bySegment.get('tvl-q1')?.sampleN, 2);
  assert.equal(bySegment.get('tvl-q2')?.sampleN, 1);
  assert.equal(bySegment.get('tvl-q3')?.sampleN, 1);
  assert.equal(bySegment.get('tvl-q4')?.sampleN, 1);
  assert.equal(bySegment.get('market-cap-top-decile')?.sampleN, 1);
  assert.equal(bySegment.get('market-cap-rest')?.sampleN, 4);
  assert.equal(bySegment.has('category-supported'), false);

  const tvlTotal = ['tvl-q1', 'tvl-q2', 'tvl-q3', 'tvl-q4'].reduce(
    (total, segment) => total + (bySegment.get(segment)?.sampleN ?? 0),
    0,
  );
  assert.equal(tvlTotal, evaluation.sampleN);
  assert.deepEqual(
    evaluation.segments.map((segment) => segment.segment),
    [
      'tvl-q1',
      'tvl-q2',
      'tvl-q3',
      'tvl-q4',
      'market-cap-top-decile',
      'market-cap-rest',
    ],
  );
});

test('category support segments are emitted for category-aware models', () => {
  const source = [
    ...Array.from({ length: 4 }, (_, index) =>
      peer({
        slug: `dex-${index}`,
        category: 'Dexs',
        tvlUsd: 10 + index * 10,
        marketCapUsd: (10 + index * 10) * 2,
      }),
    ),
    peer({
      slug: 'thin-0',
      category: 'Thin',
      tvlUsd: 20,
      marketCapUsd: 100,
    }),
  ];
  const model = fitValuationModel(
    source,
    modelSpec({
      id: 'category-median-ratio',
      kind: 'category-median-ratio',
      minCategoryN: 3,
    }),
    options(),
  );
  const evaluation = evaluateValuationModel(
    model,
    calibrationFixture(),
    [
      peer({ slug: 'd1', category: 'Dexs', tvlUsd: 20, marketCapUsd: 40 }),
      peer({ slug: 't1', category: 'Thin', tvlUsd: 20, marketCapUsd: 100 }),
      peer({ slug: 'u1', category: 'Unseen', tvlUsd: 20, marketCapUsd: 40 }),
    ],
    options(),
  );
  const segments = new Map(
    evaluation.segments.map((segment) => [segment.segment, segment]),
  );

  assert.equal(segments.get('category-supported')?.sampleN, 1);
  assert.equal(segments.get('category-sparse')?.sampleN, 1);
  assert.equal(segments.get('category-unseen')?.sampleN, 1);
});

test('evaluateValuationModel rejects empty or malformed evaluation inputs', () => {
  assert.throws(
    () =>
      evaluateValuationModel(
        evaluationModel(),
        calibrationFixture(),
        [],
        options(),
      ),
    ValuationInputError,
  );
  assert.throws(
    () =>
      evaluateValuationModel(
        evaluationModel(),
        calibrationFixture({ lowerLogOffset: 1, upperLogOffset: -1 }),
        actualPeers(),
        options(),
      ),
    ValuationInputError,
  );
  assert.throws(
    () =>
      evaluateValuationModel(
        evaluationModel(),
        calibrationFixture({ level: 1 }),
        actualPeers(),
        options(),
      ),
    ValuationInputError,
  );
  assert.throws(
    () =>
      evaluateValuationModel(
        evaluationModel(),
        calibrationFixture(),
        [peer({ slug: 'zero', tvlUsd: 0 })],
        options(),
      ),
    ValuationInputError,
  );
});

test('evaluateValuationModel rejects any target that was in the fit set', () => {
  assert.throws(
    () =>
      evaluateValuationModel(
        evaluationModel(),
        calibrationFixture(),
        [
          peer({
            slug: 'p10',
            tvlUsd: 10,
            marketCapUsd: 40,
          }),
        ],
        options(),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ValuationInputError);
      assert.match(error.message, /fit set|not fit|leak/i);
      return true;
    },
  );
});

test('buildCandidateSpecs is a deterministic, unique model grid', () => {
  const first = buildCandidateSpecs(options());
  const second = buildCandidateSpecs(options());

  assert.deepEqual(first, second);
  assert.equal(first.length, 2 + 2 * 4 * 7);
  assert.equal(new Set(first.map((spec) => spec.id)).size, first.length);
  assert.equal(first[0]?.kind, 'global-median-ratio');
  assert.equal(first[1]?.kind, 'category-median-ratio');
  assert.ok(
    first
      .filter((spec) => spec.kind === 'scale-partially-pooled')
      .every((spec) => spec.fit === 'ols' || spec.fit === 'huber'),
  );
  assert.ok(
    first.some(
      (spec) =>
        spec.id === 'scale-pooled:huber:change7d+age:k20' &&
        spec.features.length === 2,
    ),
  );
  assertDeepFrozen(first);
});

test('valueToken emits a point market-cap estimate, interval and stable peer examples', () => {
  const source = [
    peer({ slug: 'p-a', category: 'Dexs', tvlUsd: 100, marketCapUsd: 200 }),
    peer({ slug: 'p-b', category: 'Dexs', tvlUsd: 100, marketCapUsd: 200 }),
    peer({ slug: 'p-c', category: 'Dexs', tvlUsd: 100, marketCapUsd: 200 }),
    peer({ slug: 'p-d', category: 'Lending', tvlUsd: 100, marketCapUsd: 200 }),
  ];
  const model = fitValuationModel(
    source,
    modelSpec({ id: 'global-median-ratio', kind: 'global-median-ratio' }),
    options(),
  );
  const valuation = valueToken(
    {
      slug: 'target',
      category: 'Dexs',
      tvlUsd: 100,
      change7d: null,
      ageDays: null,
      watchlist: true,
    },
    model,
    source,
    calibrationFixture({ sampleN: 40, lowerLogOffset: -0.1, upperLogOffset: 0.1 }),
    options({ maxPeerExamples: 3 }),
  );

  assert.equal(valuation.source, 'watchlist');
  assert.equal(valuation.pointBasis, 'market-cap');
  assert.equal(valuation.impliedMarketCapUsd, 200);
  assert.ok(
    Math.abs(valuation.impliedLogMarketCap - Math.log(200)) < 1e-12,
  );
  assert.ok(valuation.interval.lowUsd <= valuation.impliedMarketCapUsd);
  assert.ok(valuation.interval.highUsd >= valuation.impliedMarketCapUsd);
  assert.ok(valuation.interval.widthLog > 0);
  assert.equal(valuation.peerPoolN, 4);
  assert.equal(valuation.peerCategoryN, 0);
  assert.deepEqual(
    valuation.peerExamples.map((example) => example.slug),
    ['p-a', 'p-b', 'p-c'],
  );
  assert.ok(valuation.peerExamples.every((example) => example.sameCategory));
  assert.ok(
    valuation.peerExamples.every(
      (example, index) =>
        index === 0 ||
        (valuation.peerExamples[index - 1]?.slug as string) < example.slug,
    ),
  );
  assert.deepEqual(valuation.evidenceFlags, ['global-median-ratio']);
  assert.equal(
    Object.prototype.hasOwnProperty.call(valuation, 'fdv'),
    false,
  );
  assertDeepFrozen(valuation);
});

test('valueToken requires the exact unique fit peer set and an out-of-fit target', () => {
  const source = [
    peer({ slug: 'p-a', category: 'Dexs', tvlUsd: 100, marketCapUsd: 200 }),
    peer({ slug: 'p-b', category: 'Dexs', tvlUsd: 100, marketCapUsd: 200 }),
    peer({ slug: 'p-c', category: 'Dexs', tvlUsd: 100, marketCapUsd: 200 }),
  ];
  const model = fitValuationModel(
    source,
    modelSpec({ id: 'global-median-ratio', kind: 'global-median-ratio' }),
    options(),
  );
  const calibration = calibrationFixture({ sampleN: 40 });
  const target = {
    slug: 'outside-target',
    category: 'Dexs',
    tvlUsd: 100,
    change7d: null,
    ageDays: null,
  };

  assert.throws(
    () => valueToken(target, model, source.slice(0, 2), calibration, options()),
    /exact.*fit/i,
  );
  assert.throws(
    () =>
      valueToken(
        target,
        model,
        [
          ...source,
          peer({ slug: 'p-extra', tvlUsd: 100, marketCapUsd: 200 }),
        ],
        calibration,
        options(),
      ),
    /exact.*fit/i,
  );
  assert.throws(
    () =>
      valueToken(
        { ...target, slug: 'p-a' },
        model,
        source,
        calibration,
        options(),
      ),
    /fit set|not fit|leak/i,
  );
});

test('valueToken explains category fallback, sparse support and unseen categories', () => {
  const source = [
    ...Array.from({ length: 5 }, (_, index) =>
      peer({
        slug: `dex-${index}`,
        category: 'Dexs',
        tvlUsd: 10 + index,
        marketCapUsd: (10 + index) * 2,
      }),
    ),
    ...Array.from({ length: 2 }, (_, index) =>
      peer({
        slug: `thin-${index}`,
        category: 'Thin',
        tvlUsd: 10 + index,
        marketCapUsd: (10 + index) * 10,
      }),
    ),
  ];
  const model = fitValuationModel(
    source,
    modelSpec({
      id: 'category-median-ratio',
      kind: 'category-median-ratio',
      minCategoryN: 3,
    }),
    options(),
  );
  const calibration = calibrationFixture({
    sampleN: 40,
    lowerLogOffset: -0.1,
    upperLogOffset: 0.1,
  });

  const supported = valueToken(
    {
      slug: 'supported',
      category: 'Dexs',
      tvlUsd: 12,
      change7d: 1,
      ageDays: 100,
    },
    model,
    source,
    calibration,
    options(),
  );
  assert.equal(supported.peerCategoryN, 5);
  assert.deepEqual(supported.evidenceFlags, ['category-median-ratio']);

  const thin = valueToken(
    {
      slug: 'thin-target',
      category: 'Thin',
      tvlUsd: 12,
      change7d: 1,
      ageDays: 100,
    },
    model,
    source,
    calibration,
    options(),
  );
  assert.equal(thin.peerCategoryN, 2);
  assert.deepEqual(thin.evidenceFlags, [
    'category-median-fallback',
    'sparse-category',
  ]);

  const unseen = valueToken(
    {
      slug: 'unseen-target',
      category: 'Unseen',
      tvlUsd: 12,
      change7d: 1,
      ageDays: 100,
    },
    model,
    source,
    calibration,
    options(),
  );
  assert.equal(unseen.peerCategoryN, 0);
  assert.deepEqual(unseen.evidenceFlags, [
    'category-median-fallback',
    'category-unseen',
  ]);
});

test('valueToken flags feature missingness and TVL extrapolation deterministically', () => {
  const source = scaleFixture();
  const model = fitValuationModel(
    source,
    modelSpec({
      id: 'scale-pooled:ols:change7d+age:k2',
      kind: 'scale-partially-pooled',
      fit: 'ols',
      features: ['change7d', 'age'],
      categoryShrinkage: 2,
    }),
    options(),
  );
  const calibration = calibrationFixture({
    sampleN: 40,
    lowerLogOffset: -0.1,
    upperLogOffset: 0.1,
  });

  const inside = valueToken(
    {
      slug: 'inside',
      category: 'A',
      tvlUsd: Math.exp(3),
      change7d: null,
      ageDays: null,
    },
    model,
    source,
    calibration,
    options(),
  );
  assert.ok(inside.evidenceFlags.includes('category-partially-pooled'));
  assert.ok(inside.evidenceFlags.includes('missing-change-7d'));
  assert.ok(inside.evidenceFlags.includes('missing-listed-at'));
  assert.equal(inside.evidenceFlags.includes('tvl-above-fit-range'), false);
  assert.equal(inside.evidenceFlags.includes('tvl-below-fit-range'), false);
  assert.equal(inside.peerCategoryN, 6);

  const above = valueToken(
    {
      slug: 'above',
      category: 'A',
      tvlUsd: Math.exp(10),
      change7d: 1,
      ageDays: 100,
    },
    model,
    source,
    calibration,
    options(),
  );
  assert.ok(above.evidenceFlags.includes('tvl-above-fit-range'));

  const below = valueToken(
    {
      slug: 'below',
      category: 'A',
      tvlUsd: Math.exp(0.1),
      change7d: 1,
      ageDays: 100,
    },
    model,
    source,
    calibration,
    options(),
  );
  assert.ok(below.evidenceFlags.includes('tvl-below-fit-range'));
});

test('selectValuationModel scores every candidate on training folds only', () => {
  const source = peers(40);
  const selection = selectValuationModel(source, options({ folds: 4 }));

  assert.equal(selection.strategy, 'deterministic-hash-kfold');
  assert.equal(selection.folds, 4);
  assert.equal(selection.trainingSampleN, 40);
  assert.equal(selection.candidates.length, 58);
  assert.ok(
    selection.candidates.every((candidate) =>
      Number.isFinite(candidate.cvMedianAbsLogError),
    ),
  );
  assert.ok(
    selection.candidates.some((candidate) => candidate.selected),
  );
  assert.equal(
    selection.candidates.filter((candidate) => candidate.selected).length,
    1,
  );
  assert.equal(selection.selected.id, selection.candidates.find((candidate) => candidate.selected)?.id);
  assert.ok(
    selection.selectedCvScore <=
      selection.bestRawScore + selection.toleranceLog + 1e-12,
  );
  assert.equal(selection.featureAblation.length, 8);
  assert.ok(
    selection.featureAblation
      .filter((row) => row.features.length === 0)
      .every((row) => row.deltaVsBase === 0),
  );
  assertDeepFrozen(selection);
});

test('selectValuationModel prefers the simpler baseline when tolerance allows it', () => {
  const selection = selectValuationModel(
    peers(40),
    options({ folds: 4, selectionToleranceLog: 100 }),
  );
  assert.equal(selection.selected.kind, 'global-median-ratio');
  assert.ok(selection.selectedCvScore >= selection.bestRawScore);
});

const benchmarkCategories = ['Dexs', 'Lending', 'Yield', 'RWA'] as const;

function benchmarkReport(): ReturnType<typeof adaptSnapshot> {
  const categoryOffset: Record<string, number> = {
    Dexs: 1,
    Lending: 0,
    Yield: -1,
    RWA: 0.5,
  };
  const protocols = Array.from({ length: 40 }, (_, index) => {
    const category = benchmarkCategories[index % benchmarkCategories.length] as string;
    const logTvl = Math.log(10_000_000) + (index % 10) * 0.3;
    const logMcap = 8 + 0.5 * logTvl + (categoryOffset[category] as number);
    return protocol({
      slug: `peer-${String(index).padStart(2, '0')}`,
      name: `Peer ${index}`,
      category,
      tvl_usd: Math.round(Math.exp(logTvl)),
      mcap_usd: Math.round(Math.exp(logMcap)),
      listed_at: '2024-01-01',
      change_7d: (index % 7) - 3,
      gecko_id: `gecko-${index}`,
      symbol: `P${index}`,
    });
  });
  const candidates = Array.from({ length: 6 }, (_, index) =>
    protocol({
      slug: `cand-${index}`,
      name: `Cand ${index}`,
      category: benchmarkCategories[index % benchmarkCategories.length],
      tvl_usd: 20_000_000 + index * 5_000_000,
      mcap_usd: null,
      listed_at: index % 2 === 0 ? '2025-01-01' : null,
      change_7d: index === 5 ? null : index - 2,
      gecko_id: null,
      symbol: null,
    }),
  );
  return adaptSnapshot(
    doc([...protocols, ...candidates], ['cand-0', 'cand-1', 'cand-2']),
  );
}

test('benchmarkValuation separates selection, holdout scoring and final refit', () => {
  const report = benchmarkReport();
  const benchmark = benchmarkValuation(
    report,
    options({ folds: 4, seed: 'benchmark-test-seed' }),
  );

  assert.equal(benchmark.method, 'cross-sectional-peer-benchmark');
  assert.equal(benchmark.split.trainN + benchmark.split.holdoutN, 40);
  assert.equal(benchmark.split.holdoutN, 12);
  assert.equal(benchmark.modelSelection.trainingSampleN, 28);
  assert.equal(benchmark.calibrationPool.sampleN, 28);
  assert.equal(benchmark.holdout.sampleN, 12);
  assert.deepEqual(
    benchmark.holdout.targetSlugs,
    benchmark.split.holdoutSlugs,
  );

  const comparisons: ModelEvaluation[] = [
    benchmark.holdout.baseline,
    benchmark.holdout.categoryBaseline,
    benchmark.holdout.selected,
  ];
  comparisons.forEach((evaluation) => {
    assert.equal(evaluation.sampleN, 12);
    assert.deepEqual(evaluation.fitSlugs, benchmark.split.trainSlugs);
    assert.ok(
      benchmark.split.holdoutSlugs.every(
        (slug) => !evaluation.fitSlugs.includes(slug),
      ),
    );
  });
  assert.equal(benchmark.holdout.baseline.modelId, 'global-median-ratio');
  assert.equal(benchmark.holdout.categoryBaseline.modelId, 'category-median-ratio');
  assert.equal(benchmark.holdout.selected.modelId, benchmark.modelSelection.selected.id);

  assert.equal(benchmark.final.fitSampleN, 40);
  assert.equal(benchmark.final.model.fitSlugs.length, 40);
  assert.deepEqual(
    benchmark.final.model.fitSlugs,
    report.peers.map((row) => row.slug),
  );
  assert.equal(benchmark.final.calibration.sampleN, 28);
  assert.equal(benchmark.valuations.length, 6);
  assert.deepEqual(
    benchmark.valuations.map((valuation) => valuation.slug),
    ['cand-0', 'cand-1', 'cand-2', 'cand-3', 'cand-4', 'cand-5'],
  );
  assert.deepEqual(
    benchmark.valuations.map((valuation) => valuation.source),
    ['watchlist', 'watchlist', 'watchlist', 'candidate', 'candidate', 'candidate'],
  );
  benchmark.valuations.forEach((valuation) => {
    assert.equal(valuation.pointBasis, 'market-cap');
    assert.ok(valuation.impliedMarketCapUsd > 0);
    assert.ok(valuation.interval.lowUsd <= valuation.impliedMarketCapUsd);
    assert.ok(valuation.interval.highUsd >= valuation.impliedMarketCapUsd);
    assert.ok(valuation.peerExamples.length > 0);
    assert.equal(valuation.peerPoolN, 40);
    assert.ok(Array.isArray(valuation.evidenceFlags));
  });

  assert.equal(benchmark.interpretation.isLaunchBacktest, false);
  assert.equal(benchmark.interpretation.isProbability, false);
  assert.equal(
    benchmark.interpretation.kind,
    'cross-sectional-peer-benchmark',
  );
  assert.ok(benchmark.limits.length >= 3);
  assertDeepFrozen(benchmark);
});

test('benchmarkValuation is deterministic and fully JSON-serializable', () => {
  const report = benchmarkReport();
  const first = benchmarkValuation(
    report,
    options({ folds: 4, seed: 'serialization-seed' }),
  );
  const second = benchmarkValuation(
    report,
    options({ folds: 4, seed: 'serialization-seed' }),
  );

  assert.deepEqual(first, second);
  const roundTrip = JSON.parse(JSON.stringify(first)) as ValuationBenchmark;
  assert.deepEqual(roundTrip, first);
});

test('toDossierSummary is compact, signed and free of raw IDs and records', () => {
  const benchmark = benchmarkValuation(
    benchmarkReport(),
    options({ folds: 4, seed: 'dossier-seed' }),
  );
  const summary: DossierSummary = toDossierSummary(benchmark);
  const serialized = JSON.stringify(summary);

  assert.ok(
    Buffer.byteLength(serialized, 'utf8') <= 8192,
    `dossier summary is ${Buffer.byteLength(serialized, 'utf8')} bytes`,
  );
  assert.doesNotMatch(
    serialized,
    /"(?:slug|id|modelId|records|fitSlugs|targetSlugs|peerExamples|candidates)":/,
  );
  assert.equal(summary.valuations.count, 6);
  assert.equal(summary.valuations.watchlistN, 3);
  assert.equal(summary.valuations.candidateN, 3);
  assert.deepEqual(summary.valuations.tokenStatusCounts, {
    'already-tokenized': 0,
    'watchlist-unconfirmed': 3,
    candidate: 3,
  });
  assert.equal(summary.holdout.selected.sampleN, 12);
  assert.ok(Number.isFinite(summary.holdout.selected.medianSignedLogError));
  assert.ok(Number.isFinite(summary.holdout.selected.meanSignedLogError));
  assert.ok(
    summary.limits.some((limit) => /80%/.test(limit) && /not.*precision/i.test(limit)),
  );
  assert.ok(
    summary.limits.some(
      (limit) => /cross-sectional/i.test(limit) && /not.*forecast/i.test(limit),
    ),
  );
  assert.equal(summary.calibration.level, 0.8);
  assert.equal(summary.calibration.sampleN, 28);
});

test('valueCandidates values every candidate with a stable slug order', () => {
  const report = benchmarkReport();
  const peersPrepared = prepareValuationPeers(report);
  const model = fitValuationModel(
    peersPrepared,
    modelSpec({ id: 'global-median-ratio', kind: 'global-median-ratio' }),
    options(),
  );
  const valuations = valueCandidates(
    report,
    model,
    peersPrepared,
    calibrationFixture({ sampleN: 40 }),
    options(),
  );

  assert.equal(valuations.length, 6);
  assert.deepEqual(
    valuations.map((valuation) => valuation.slug),
    [...valuations.map((valuation) => valuation.slug)].sort(),
  );
  assert.ok(
    valuations.every(
      (valuation) =>
        valuation.peerExamples.length > 0 &&
        valuation.interval.lowUsd <= valuation.impliedMarketCapUsd &&
        valuation.interval.highUsd >= valuation.impliedMarketCapUsd,
    ),
  );
});

test('valueCandidates preserves already-tokenized watchlist status and actual mcap', () => {
  const report = adaptSnapshot(
    doc(
      [
        ...Array.from({ length: 5 }, (_, index) =>
          protocol({
            slug: `peer-${index}`,
            name: `Peer ${index}`,
            category: 'Dexs',
            tvl_usd: 100,
            mcap_usd: 200,
            gecko_id: `peer-${index}`,
            symbol: `P${index}`,
          }),
        ),
        protocol({
          slug: 'watch-already',
          name: 'Watch Already',
          category: 'Dexs',
          tvl_usd: 200,
          mcap_usd: 500,
          gecko_id: 'watch-already',
          symbol: 'WA',
        }),
        protocol({
          slug: 'watch-unconfirmed',
          name: 'Watch Unconfirmed',
          category: 'Dexs',
          tvl_usd: 200,
          mcap_usd: null,
          gecko_id: null,
          symbol: null,
        }),
        protocol({
          slug: 'missing-metadata',
          name: 'Missing Metadata',
          category: 'Dexs',
          tvl_usd: 200,
          mcap_usd: null,
          gecko_id: null,
          symbol: null,
        }),
      ],
      ['watch-already', 'watch-unconfirmed'],
    ),
  );
  const peersPrepared = prepareValuationPeers(report);
  const model = fitValuationModel(
    peersPrepared,
    modelSpec({ id: 'global-median-ratio', kind: 'global-median-ratio' }),
    options(),
  );
  const valuations = valueCandidates(
    report,
    model,
    peersPrepared,
    calibrationFixture({ sampleN: 40 }),
    options(),
  );
  const bySlug = new Map(valuations.map((valuation) => [valuation.slug, valuation]));

  assert.equal(valuations.length, 3, 'already-tokenized rows are not skipped');
  const already = bySlug.get('watch-already');
  assert.ok(already);
  assert.equal(already.source, 'watchlist');
  assert.equal(already.tokenStatus, 'already-tokenized');
  assert.equal(already.actualMarketCapUsd, 500);

  const unconfirmed = bySlug.get('watch-unconfirmed');
  assert.ok(unconfirmed);
  assert.equal(unconfirmed.source, 'watchlist');
  assert.equal(unconfirmed.tokenStatus, 'watchlist-unconfirmed');
  assert.equal(unconfirmed.actualMarketCapUsd, null);

  const missing = bySlug.get('missing-metadata');
  assert.ok(missing);
  assert.equal(missing.source, 'candidate');
  assert.equal(missing.tokenStatus, 'candidate');
  assert.equal(missing.actualMarketCapUsd, null);
});

const REAL_SNAPSHOT_SHA256 =
  '42a71213519479f3a180cc5010cbbf6bd18a2447fa0ad29e4c5122b6c9184393';
const realSnapshotPath =
  process.env.TOKEN_RADAR_SNAPSHOT ??
  'D:/hermes/cache/scratch/token-radar-snapshot/snapshot.json';
const realSnapshotAvailable = existsSync(realSnapshotPath);
const realSnapshotRequired = process.env.TOKEN_RADAR_REQUIRE_SNAPSHOT === '1';

test(
  'benchmarks the verified real snapshot without holdout leakage',
  { skip: !realSnapshotAvailable && !realSnapshotRequired },
  () => {
    assert.ok(
      realSnapshotAvailable,
      `TOKEN_RADAR_REQUIRE_SNAPSHOT=1 but snapshot is missing: ${realSnapshotPath}`,
    );
    const bytes = readFileSync(realSnapshotPath);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      REAL_SNAPSHOT_SHA256,
      'scratch snapshot does not match the kit manifest hash',
    );
    const raw: unknown = JSON.parse(bytes.toString('utf8'));
    const report = adaptSnapshot(raw);
    assert.equal(report.peers.length, 127);
    assert.equal(report.candidates.length, 197);
    assert.equal(
      report.candidates.filter((row) => row.reason === 'watchlist').length,
      40,
    );
    const circleGateway = report.excluded.find(
      (row) => row.slug === 'circle-gateway',
    );
    assert.ok(circleGateway, 'official circle-gateway exclusion is missing');
    assert.ok(circleGateway.exclusions.includes('bridged-category'));
    assert.equal(
      report.candidates.some((row) => row.slug === 'circle-gateway'),
      false,
    );

    const benchmark = benchmarkValuation(report, {
      seed: 'token-radar-valuation-v1',
      holdoutFraction: 0.3,
      folds: 5,
      intervalLevel: 0.8,
    });

    assert.equal(benchmark.split.trainN + benchmark.split.holdoutN, 127);
    assert.equal(benchmark.split.holdoutN, 38);
    assert.equal(benchmark.split.trainN, 89);
    assert.equal(benchmark.modelSelection.trainingSampleN, 89);
    assert.equal(benchmark.calibrationPool.sampleN, 89);
    assert.equal(benchmark.calibrationPool.folds, 5);
    assert.equal(benchmark.holdout.sampleN, 38);
    assert.deepEqual(
      benchmark.holdout.targetSlugs,
      benchmark.split.holdoutSlugs,
    );

    const evaluations = [
      benchmark.holdout.baseline,
      benchmark.holdout.categoryBaseline,
      benchmark.holdout.selected,
    ];
    evaluations.forEach((evaluation) => {
      assert.equal(evaluation.sampleN, 38);
      assert.equal(evaluation.fitSampleN, 89);
      assert.deepEqual(evaluation.fitSlugs, benchmark.split.trainSlugs);
      assert.ok(
        benchmark.split.holdoutSlugs.every(
          (slug) => !evaluation.fitSlugs.includes(slug),
        ),
      );
      assert.ok(
        Number.isFinite(evaluation.medianAbsLogError) &&
          evaluation.medianAbsLogError >= 0,
      );
      assert.ok(
        Number.isFinite(evaluation.medianAbsolutePercentageError) &&
          evaluation.medianAbsolutePercentageError >= 0,
      );
      assert.ok(Number.isFinite(evaluation.medianSignedLogError));
      assert.ok(Number.isFinite(evaluation.meanSignedLogError));
      assert.ok(evaluation.coverage >= 0 && evaluation.coverage <= 1);
      assert.ok(
        Number.isFinite(evaluation.medianIntervalLogWidth) &&
          evaluation.medianIntervalLogWidth > 0,
      );
      assert.equal(evaluation.records.length, 38);
    });
    assert.equal(benchmark.holdout.baseline.modelId, 'global-median-ratio');
    assert.equal(
      benchmark.holdout.categoryBaseline.modelId,
      'category-median-ratio',
    );
    assert.equal(
      benchmark.holdout.selected.modelId,
      benchmark.modelSelection.selected.id,
    );
    assert.ok(
      benchmark.modelSelection.selectedCvScore <=
        benchmark.modelSelection.bestRawScore +
          benchmark.modelSelection.toleranceLog +
          1e-12,
    );

    assert.equal(benchmark.final.fitSampleN, 127);
    assert.deepEqual(
      benchmark.final.model.fitSlugs,
      report.peers.map((row) => row.slug),
    );
    assert.equal(benchmark.final.calibration.sampleN, 89);
    assert.equal(benchmark.valuations.length, report.candidates.length);
    assert.deepEqual(
      benchmark.valuations.map((valuation) => valuation.slug),
      report.candidates.map((row) => row.slug),
    );
    assert.equal(
      report.candidates.filter((row) =>
        row.flags.includes('already-tokenized'),
      ).length,
      0,
      'this snapshot has no already-tokenized watchlist rows',
    );
    benchmark.valuations.forEach((valuation) => {
      assert.equal(valuation.pointBasis, 'market-cap');
      assert.ok(Number.isFinite(valuation.impliedMarketCapUsd));
      assert.ok(valuation.impliedMarketCapUsd > 0);
      assert.ok(valuation.interval.lowUsd <= valuation.impliedMarketCapUsd);
      assert.ok(valuation.interval.highUsd >= valuation.impliedMarketCapUsd);
      assert.equal(valuation.peerPoolN, 127);
      assert.ok(valuation.peerExamples.length > 0);
      assert.ok(valuation.peerExamples.length <= 5);
      assert.ok(Array.isArray(valuation.evidenceFlags));
      assert.match(valuation.tokenStatus, /already-tokenized|watchlist-unconfirmed|candidate/);
    });

    assert.equal(benchmark.interpretation.isLaunchBacktest, false);
    assert.equal(benchmark.interpretation.isProbability, false);
    assert.equal(
      benchmark.interpretation.kind,
      'cross-sectional-peer-benchmark',
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(benchmark)),
      benchmark,
    );

    const summary = toDossierSummary(benchmark);
    assert.ok(Buffer.byteLength(JSON.stringify(summary), 'utf8') <= 8192);
    assert.equal(summary.valuations.count, report.candidates.length);
  },
);
