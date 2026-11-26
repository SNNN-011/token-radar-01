/**
 * Deterministic evaluation, interval calibration and model selection for the
 * Token Radar cross-sectional valuation.
 *
 * Separation contract:
 * - hyperparameters and the model family are chosen with deterministic K-fold
 *   cross-validation inside the TRAINING peers only;
 * - interval offsets are empirical quantiles of out-of-fold TRAINING residuals;
 * - the untouched holdout is scored once, after all of that is frozen;
 * - only then may a caller refit the selected model on all peers.
 *
 * No holdout value is used for fitting, calibration or selection here.
 *
 * Loop discipline: folds, peers and feature grids are bounded arrays. The only
 * iterative numerical routine is Huber IRLS inside `lib/valuation.ts`, which is
 * capped by `huberMaxIterations` and starts from an OLS solution.
 */

import { createHash } from 'node:crypto';

import type { SnapshotReport } from './snapshot.ts';
import {
  ValuationInputError,
  fitValuationModel,
  predictLogMarketCap,
  prepareValuationPeers,
  quantileSorted,
  resolveValuationOptions,
  splitValuationPeers,
  valueCandidates,
} from './valuation.ts';
import type {
  FittedValuationModel,
  IntervalCalibration,
  RegressionFit,
  TokenValuation,
  ValuationFeature,
  ValuationModelKind,
  ValuationModelSpec,
  ValuationOptions,
  ValuationPeer,
} from './valuation.ts';

export interface EvaluationRecord {
  readonly slug: string;
  readonly actualLogMarketCap: number;
  readonly predictedLogMarketCap: number;
  readonly residualLog: number;
  readonly intervalLowLog: number;
  readonly intervalHighLog: number;
  readonly intervalLogWidth: number;
  readonly insideInterval: boolean;
}

export interface SegmentEvaluation {
  readonly segment: string;
  readonly sampleN: number;
  readonly medianAbsLogError: number;
  readonly coverage: number;
  readonly medianIntervalLogWidth: number;
}

export interface ModelEvaluation {
  readonly modelId: string;
  readonly sampleN: number;
  readonly fitSampleN: number;
  readonly fitSlugs: readonly string[];
  readonly intervalLevel: number;
  readonly medianAbsLogError: number;
  readonly meanAbsLogError: number;
  readonly rootMeanSquaredLogError: number;
  /** Median(actual log - predicted log); positive means underprediction. */
  readonly medianSignedLogError: number;
  /** Mean(actual log - predicted log); positive means underprediction. */
  readonly meanSignedLogError: number;
  readonly medianAbsolutePercentageError: number;
  readonly coverage: number;
  readonly medianIntervalLogWidth: number;
  readonly segments: readonly SegmentEvaluation[];
  readonly records: readonly EvaluationRecord[];
}

function compareSlugs(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new ValuationInputError('median of an empty sample');
  }
  const sorted = [...values].sort((left, right) => left - right);
  return quantileSorted(sorted, 0.5);
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function foldAssignment(
  peers: readonly ValuationPeer[],
  options: ValuationOptions,
): readonly (readonly ValuationPeer[])[] {
  if (peers.length < options.folds) {
    throw new ValuationInputError(
      `at least ${options.folds} peers are required for ${options.folds}-fold calibration`,
    );
  }
  const ordered = [...peers].sort((left, right) => {
    const leftKey = createHash('sha256')
      .update(`${options.seed}\u0000fold\u0000${left.slug}`)
      .digest('hex');
    const rightKey = createHash('sha256')
      .update(`${options.seed}\u0000fold\u0000${right.slug}`)
      .digest('hex');
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    return compareSlugs(left.slug, right.slug);
  });

  const folds = Array.from({ length: options.folds }, () => [] as ValuationPeer[]);
  ordered.forEach((peerValue, index) => {
    (folds[index % options.folds] as ValuationPeer[]).push(peerValue);
  });

  return Object.freeze(
    folds.map((fold) =>
      Object.freeze([...fold].sort((left, right) => compareSlugs(left.slug, right.slug))),
    ),
  );
}

function outOfFoldResiduals(
  peers: readonly ValuationPeer[],
  spec: ValuationModelSpec,
  options: ValuationOptions,
): readonly number[] {
  const folds = foldAssignment(peers, options);
  const residuals: number[] = [];

  folds.forEach((fold) => {
    const foldSlugs = new Set(fold.map((entry) => entry.slug));
    const training = peers.filter((entry) => !foldSlugs.has(entry.slug));
    if (training.length === 0) {
      throw new ValuationInputError(
        `fold ${fold.map((entry) => entry.slug).join(',')} leaves no training peers`,
      );
    }
    const model = fitValuationModel(training, spec, options);
    fold.forEach((target) => {
      const prediction = predictLogMarketCap(model, target, options);
      residuals.push(Math.log(target.marketCapUsd) - prediction);
    });
  });

  return Object.freeze(residuals);
}

function assertCalibration(calibration: IntervalCalibration): void {
  if (
    !isFiniteNumber(calibration.level) ||
    calibration.level <= 0 ||
    calibration.level >= 1
  ) {
    throw new ValuationInputError('calibration.level must be in (0, 1)');
  }
  if (
    !isFiniteNumber(calibration.sampleN) ||
    !Number.isSafeInteger(calibration.sampleN) ||
    calibration.sampleN < 1
  ) {
    throw new ValuationInputError('calibration.sampleN must be a positive integer');
  }
  if (
    !isFiniteNumber(calibration.lowerLogOffset) ||
    !isFiniteNumber(calibration.upperLogOffset) ||
    calibration.lowerLogOffset > calibration.upperLogOffset
  ) {
    throw new ValuationInputError(
      'calibration offsets must be finite and lower <= upper',
    );
  }
  if (
    !isFiniteNumber(calibration.medianAbsLogError) ||
    calibration.medianAbsLogError < 0
  ) {
    throw new ValuationInputError(
      'calibration.medianAbsLogError must be a finite number >= 0',
    );
  }
  if (
    !isFiniteNumber(calibration.coverage) ||
    calibration.coverage < 0 ||
    calibration.coverage > 1
  ) {
    throw new ValuationInputError('calibration.coverage must be in [0, 1]');
  }
}

/**
 * Calibrate a central empirical interval from TRAINING-only out-of-fold
 * residuals. The returned coverage is the observed OOF coverage, not an
 * assumed probability.
 */
export function calibrateValuationModel(
  peers: readonly ValuationPeer[],
  spec: ValuationModelSpec,
  inputOptions: Partial<ValuationOptions> = {},
): IntervalCalibration {
  const options = resolveValuationOptions(inputOptions);
  if (peers.length < 2) {
    throw new ValuationInputError(
      'at least two peers are required to calibrate a valuation interval',
    );
  }
  const residuals = outOfFoldResiduals(peers, spec, options);
  const sorted = [...residuals].sort((left, right) => left - right);
  const tail = (1 - options.intervalLevel) / 2;
  const lowerLogOffset = quantileSorted(sorted, tail);
  const upperLogOffset = quantileSorted(sorted, 1 - tail);
  const inside = residuals.filter(
    (value) => value >= lowerLogOffset && value <= upperLogOffset,
  ).length;

  return Object.freeze({
    level: options.intervalLevel,
    sampleN: residuals.length,
    lowerLogOffset,
    upperLogOffset,
    medianAbsLogError: median(residuals.map((value) => Math.abs(value))),
    coverage: inside / residuals.length,
  });
}

function categoryStatFor(
  model: FittedValuationModel,
  category: string | null,
):
  | FittedValuationModel['categoryStats'][number]
  | undefined {
  const key = category ?? '(uncategorized)';
  return model.categoryStats.find((entry) => entry.category === key);
}

function tvlSegment(
  model: FittedValuationModel,
  logTvl: number,
): 'tvl-q1' | 'tvl-q2' | 'tvl-q3' | 'tvl-q4' {
  const [q25, q50, q75] = model.tvlQuartilesLog;
  if (logTvl <= q25) return 'tvl-q1';
  if (logTvl <= q50) return 'tvl-q2';
  if (logTvl <= q75) return 'tvl-q3';
  return 'tvl-q4';
}

function categorySegment(
  model: FittedValuationModel,
  category: string | null,
): 'category-supported' | 'category-sparse' | 'category-unseen' {
  const stat = categoryStatFor(model, category);
  if (stat === undefined) return 'category-unseen';
  return stat.supported
    ? 'category-supported'
    : 'category-sparse';
}

function segmentMetrics(
  segment: string,
  records: readonly EvaluationRecord[],
): SegmentEvaluation {
  return Object.freeze({
    segment,
    sampleN: records.length,
    medianAbsLogError: median(
      records.map((record) => Math.abs(record.residualLog)),
    ),
    coverage:
      records.filter((record) => record.insideInterval).length / records.length,
    medianIntervalLogWidth: median(
      records.map((record) => record.intervalLogWidth),
    ),
  });
}

/**
 * Score a fitted model on peers that were not used to fit it. Intervals are
 * expanded minimally to contain the point estimate when empirical residual
 * quantiles are asymmetric. Coverage is reported exactly as observed.
 */
export function evaluateValuationModel(
  model: FittedValuationModel,
  calibration: IntervalCalibration,
  targets: readonly ValuationPeer[],
  inputOptions: Partial<ValuationOptions> = {},
): ModelEvaluation {
  const options = resolveValuationOptions(inputOptions);
  assertCalibration(calibration);
  if (targets.length === 0) {
    throw new ValuationInputError(
      'at least one evaluation target is required',
    );
  }

  const seen = new Set<string>();
  const fitSlugs = new Set(model.fitSlugs);
  const records = targets.map((target): EvaluationRecord => {
    if (seen.has(target.slug)) {
      throw new ValuationInputError(
        `duplicate evaluation target slug "${target.slug}"`,
      );
    }
    seen.add(target.slug);
    if (fitSlugs.has(target.slug)) {
      throw new ValuationInputError(
        `${target.slug} is in the fit set; evaluateValuationModel requires out-of-fit targets`,
      );
    }
    if (!isFiniteNumber(target.marketCapUsd) || target.marketCapUsd <= 0) {
      throw new ValuationInputError(
        `${target.slug}.marketCapUsd must be a positive finite number`,
      );
    }
    const predictedLogMarketCap = predictLogMarketCap(model, target, options);
    const actualLogMarketCap = Math.log(target.marketCapUsd);
    const residualLog = actualLogMarketCap - predictedLogMarketCap;
    const intervalLowLog = Math.min(
      predictedLogMarketCap + calibration.lowerLogOffset,
      predictedLogMarketCap,
    );
    const intervalHighLog = Math.max(
      predictedLogMarketCap + calibration.upperLogOffset,
      predictedLogMarketCap,
    );

    return Object.freeze({
      slug: target.slug,
      actualLogMarketCap,
      predictedLogMarketCap,
      residualLog,
      intervalLowLog,
      intervalHighLog,
      intervalLogWidth: intervalHighLog - intervalLowLog,
      insideInterval:
        actualLogMarketCap >= intervalLowLog &&
        actualLogMarketCap <= intervalHighLog,
    });
  });

  const sortedRecords = [...records].sort((left, right) =>
    compareSlugs(left.slug, right.slug),
  );
  const recordBySlug = new Map(
    sortedRecords.map((record) => [record.slug, record]),
  );
  const residuals = sortedRecords.map((record) => record.residualLog);
  const absolute = residuals.map((value) => Math.abs(value));

  const tvlBuckets = new Map<string, EvaluationRecord[]>([
    ['tvl-q1', []],
    ['tvl-q2', []],
    ['tvl-q3', []],
    ['tvl-q4', []],
  ]);
  const tailBuckets = new Map<string, EvaluationRecord[]>([
    ['market-cap-top-decile', []],
    ['market-cap-rest', []],
  ]);
  const categoryBuckets = new Map<string, EvaluationRecord[]>([
    ['category-supported', []],
    ['category-sparse', []],
    ['category-unseen', []],
  ]);

  targets.forEach((target) => {
    const record = recordBySlug.get(target.slug);
    if (record === undefined) {
      throw new ValuationInputError(
        `missing evaluation record for ${target.slug}`,
      );
    }
    const tvlKey = tvlSegment(model, Math.log(target.tvlUsd));
    (tvlBuckets.get(tvlKey) as EvaluationRecord[]).push(record);
    const tailKey =
      target.marketCapUsd >= model.marketCapP90Usd
        ? 'market-cap-top-decile'
        : 'market-cap-rest';
    (tailBuckets.get(tailKey) as EvaluationRecord[]).push(record);
    if (model.categoryStats.length > 0) {
      const categoryKey = categorySegment(model, target.category);
      (categoryBuckets.get(categoryKey) as EvaluationRecord[]).push(record);
    }
  });

  const segmentOrder = [
    'tvl-q1',
    'tvl-q2',
    'tvl-q3',
    'tvl-q4',
    'market-cap-top-decile',
    'market-cap-rest',
    'category-supported',
    'category-sparse',
    'category-unseen',
  ] as const;
  const segments = segmentOrder
    .map((key) => {
      const bucket = tvlBuckets.get(key) ??
        tailBuckets.get(key) ??
        categoryBuckets.get(key);
      return bucket === undefined || bucket.length === 0
        ? undefined
        : segmentMetrics(key, bucket);
    })
    .filter((segment): segment is SegmentEvaluation => segment !== undefined);

  return Object.freeze({
    modelId: model.spec.id,
    sampleN: sortedRecords.length,
    fitSampleN: model.fitSampleN,
    fitSlugs: model.fitSlugs,
    intervalLevel: calibration.level,
    medianAbsLogError: median(absolute),
    meanAbsLogError: mean(absolute),
    rootMeanSquaredLogError: Math.sqrt(
      residuals.reduce((total, value) => total + value * value, 0) /
        residuals.length,
    ),
    medianSignedLogError: median(residuals),
    meanSignedLogError: mean(residuals),
    medianAbsolutePercentageError:
      100 *
      median(
        residuals.map((value) => Math.abs(1 - Math.exp(-value))),
      ),
    coverage:
      sortedRecords.filter((record) => record.insideInterval).length /
      sortedRecords.length,
    medianIntervalLogWidth: median(
      sortedRecords.map((record) => record.intervalLogWidth),
    ),
    segments: Object.freeze(segments),
    records: Object.freeze(sortedRecords),
  });
}

const FEATURE_SETS: readonly (readonly ValuationFeature[])[] = Object.freeze([
  Object.freeze([]),
  Object.freeze(['change7d'] as const),
  Object.freeze(['age'] as const),
  Object.freeze(['change7d', 'age'] as const),
]);

const FITS: readonly RegressionFit[] = Object.freeze(['ols', 'huber']);

function featureKey(features: readonly ValuationFeature[]): string {
  return features.length === 0 ? 'base' : features.join('+');
}

/**
 * Deterministic candidate grid. Baselines come first; scale variants are
 * ordered by fit, then feature set, then non-negative shrinkage.
 */
export function buildCandidateSpecs(
  inputOptions: Partial<ValuationOptions> = {},
): readonly ValuationModelSpec[] {
  const options = resolveValuationOptions(inputOptions);
  const shrinkages = [...new Set(options.categoryShrinkageGrid)].sort(
    (left, right) => left - right,
  );

  const specs: ValuationModelSpec[] = [
    Object.freeze({
      id: 'global-median-ratio',
      kind: 'global-median-ratio',
      fit: null,
      features: Object.freeze([] as ValuationFeature[]),
      categoryShrinkage: 0,
      minCategoryN: options.minCategoryN,
    }),
    Object.freeze({
      id: 'category-median-ratio',
      kind: 'category-median-ratio',
      fit: null,
      features: Object.freeze([] as ValuationFeature[]),
      categoryShrinkage: 0,
      minCategoryN: options.minCategoryN,
    }),
  ];

  FITS.forEach((fit) => {
    FEATURE_SETS.forEach((features) => {
      shrinkages.forEach((shrinkage) => {
        specs.push(
          Object.freeze({
            id: `scale-pooled:${fit}:${featureKey(features)}:k${String(shrinkage)}`,
            kind: 'scale-partially-pooled',
            fit,
            features: Object.freeze([...features]),
            categoryShrinkage: shrinkage,
            minCategoryN: options.minCategoryN,
          }),
        );
      });
    });
  });

  return Object.freeze(specs);
}

/** One deterministic cross-validation score in the candidate grid. */
export interface CandidateScore {
  readonly id: string;
  readonly kind: ValuationModelKind;
  readonly fit: RegressionFit | null;
  readonly features: readonly ValuationFeature[];
  readonly categoryShrinkage: number;
  readonly complexity: number;
  readonly cvMedianAbsLogError: number;
  readonly eligible: boolean;
  readonly selected: boolean;
}

export interface FeatureAblation {
  readonly fit: RegressionFit;
  readonly features: readonly ValuationFeature[];
  readonly bestModelId: string;
  readonly bestScore: number;
  readonly bestShrinkage: number;
  readonly deltaVsBase: number;
}

export interface ModelSelectionReport {
  readonly strategy: 'deterministic-hash-kfold';
  readonly folds: number;
  readonly trainingSampleN: number;
  readonly selectionMetric: 'median-absolute-log-error';
  readonly toleranceLog: number;
  readonly bestRawScore: number;
  readonly selectedCvScore: number;
  readonly selected: ValuationModelSpec;
  readonly candidates: readonly CandidateScore[];
  readonly featureAblation: readonly FeatureAblation[];
  readonly note: string;
}

function modelComplexity(spec: ValuationModelSpec): number {
  if (spec.kind === 'global-median-ratio') return 0;
  if (spec.kind === 'category-median-ratio') return 1;
  return (
    2 +
    spec.features.length * 0.1 +
    (spec.fit === 'huber' ? 0.05 : 0) +
    (spec.categoryShrinkage > 0 ? 0.01 : 0)
  );
}

function compareCandidateScores(
  left: CandidateScore,
  right: CandidateScore,
): number {
  if (left.cvMedianAbsLogError !== right.cvMedianAbsLogError) {
    return left.cvMedianAbsLogError - right.cvMedianAbsLogError;
  }
  return compareSlugs(left.id, right.id);
}

/**
 * Select a model family and its hyperparameters with deterministic K-fold
 * cross-validation on training peers only. The holdout is not a parameter.
 *
 * Rule: the lowest CV median absolute log error sets the bar. Any candidate
 * within `selectionToleranceLog` of that bar is eligible, and the least
 * complex eligible candidate wins. This prefers the transparent baseline when
 * a richer model is not meaningfully better.
 */
export function selectValuationModel(
  trainingPeers: readonly ValuationPeer[],
  inputOptions: Partial<ValuationOptions> = {},
): ModelSelectionReport {
  const options = resolveValuationOptions(inputOptions);
  if (trainingPeers.length < options.folds) {
    throw new ValuationInputError(
      `at least ${options.folds} training peers are required for model selection`,
    );
  }
  const specs = buildCandidateSpecs(options);
  const scored = specs.map((spec): CandidateScore => {
    const residuals = outOfFoldResiduals(trainingPeers, spec, options);
    return Object.freeze({
      id: spec.id,
      kind: spec.kind,
      fit: spec.fit,
      features: Object.freeze([...spec.features]),
      categoryShrinkage: spec.categoryShrinkage,
      complexity: modelComplexity(spec),
      cvMedianAbsLogError: median(residuals.map((value) => Math.abs(value))),
      eligible: false,
      selected: false,
    });
  });

  const bestRawScore = Math.min(
    ...scored.map((candidate) => candidate.cvMedianAbsLogError),
  );
  if (!Number.isFinite(bestRawScore)) {
    throw new ValuationInputError(
      'model selection produced no finite cross-validation score',
    );
  }

  const eligible = scored.filter(
    (candidate) =>
      candidate.cvMedianAbsLogError <= bestRawScore + options.selectionToleranceLog,
  );
  const winner = [...eligible].sort((left, right) => {
    if (left.complexity !== right.complexity) {
      return left.complexity - right.complexity;
    }
    if (left.cvMedianAbsLogError !== right.cvMedianAbsLogError) {
      return left.cvMedianAbsLogError - right.cvMedianAbsLogError;
    }
    return compareSlugs(left.id, right.id);
  })[0] as CandidateScore;

  const candidates = Object.freeze(
    [...scored]
      .sort(compareCandidateScores)
      .map((candidate) =>
        Object.freeze({
          ...candidate,
          eligible: candidate.cvMedianAbsLogError <= bestRawScore + options.selectionToleranceLog,
          selected: candidate.id === winner.id,
        }),
      ),
  );
  const selected = specs.find((spec) => spec.id === winner.id);
  if (selected === undefined) {
    throw new ValuationInputError('selected valuation model is missing');
  }

  const ablationRows: FeatureAblation[] = [];
  FITS.forEach((fit) => {
    const base = candidates
      .filter(
        (candidate) =>
          candidate.kind === 'scale-partially-pooled' &&
          candidate.fit === fit &&
          candidate.features.length === 0,
      )
      .sort(compareCandidateScores)[0];
    if (base === undefined) return;
    FEATURE_SETS.forEach((features) => {
      const best = candidates
        .filter(
          (candidate) =>
            candidate.kind === 'scale-partially-pooled' &&
            candidate.fit === fit &&
            candidate.features.length === features.length &&
            candidate.features.every((feature, index) => feature === features[index]),
        )
        .sort(compareCandidateScores)[0];
      if (best === undefined) return;
      ablationRows.push(
        Object.freeze({
          fit,
          features: Object.freeze([...features]),
          bestModelId: best.id,
          bestScore: best.cvMedianAbsLogError,
          bestShrinkage: best.categoryShrinkage,
          deltaVsBase: best.cvMedianAbsLogError - base.cvMedianAbsLogError,
        }),
      );
    });
  });

  return Object.freeze({
    strategy: 'deterministic-hash-kfold',
    folds: options.folds,
    trainingSampleN: trainingPeers.length,
    selectionMetric: 'median-absolute-log-error',
    toleranceLog: options.selectionToleranceLog,
    bestRawScore,
    selectedCvScore: winner.cvMedianAbsLogError,
    selected,
    candidates,
    featureAblation: Object.freeze(ablationRows),
    note:
      'Folds are SHA-256 slug hashes inside the training peers; the untouched holdout is not used for selection or calibration.',
  });
}

export interface HoldoutComparison {
  readonly sampleN: number;
  readonly targetSlugs: readonly string[];
  readonly baseline: ModelEvaluation;
  readonly categoryBaseline: ModelEvaluation;
  readonly selected: ModelEvaluation;
}

export type BenchmarkInterpretation = {
  readonly kind: 'cross-sectional-peer-benchmark';
  readonly isLaunchBacktest: false;
  readonly isProbability: false;
  readonly statement: string;
};

export interface ValuationBenchmark {
  readonly asOf: string;
  readonly method: 'cross-sectional-peer-benchmark';
  readonly seed: string;
  readonly options: ValuationOptions;
  readonly split: {
    readonly strategy: 'deterministic-hash-holdout';
    readonly trainN: number;
    readonly holdoutN: number;
    readonly trainSlugs: readonly string[];
    readonly holdoutSlugs: readonly string[];
  };
  readonly modelSelection: ModelSelectionReport;
  readonly calibrationPool: {
    readonly level: number;
    readonly folds: number;
    readonly sampleN: number;
    readonly note: string;
  };
  readonly holdout: HoldoutComparison;
  readonly final: {
    readonly model: FittedValuationModel;
    readonly calibration: IntervalCalibration;
    readonly fitSampleN: number;
    readonly note: string;
  };
  readonly valuations: readonly TokenValuation[];
  readonly interpretation: BenchmarkInterpretation;
  readonly limits: readonly string[];
}

const BENCHMARK_LIMITS: readonly string[] = Object.freeze([
  'One cross-sectional snapshot only; this is not a temporal or launch backtest.',
  'Intervals are empirical peer-residual quantile bands, not probabilities of a future market cap.',
  'Peers are unevenly supported by category and the holdout is a slug hash, not a random sample of launches.',
  'The peer pool is the adapter tokenized partition, which retains tokenized CEX, bridge and liquid-staking protocols even though candidate eligibility excludes those categories.',
  'Category offsets are zero below minCategoryN and shrunk toward the global fit on supported categories; sparse categories remain noisy, so check the evidence flags per valuation.',
  'Point estimates are implied market caps, never FDV, and depend on the frozen peer set.',
  'Final all-peer coefficients are not scored on the holdout; the reported holdout models were fit on training peers only.',
]);

/**
 * Run the frozen benchmark protocol:
 * 1. deterministic training/holdout split;
 * 2. model selection and interval calibration on training peers only;
 * 3. one untouched holdout scoring pass for the global baseline, the category
 *    baseline and the selected model;
 * 4. only after those scores are recorded, refit the selected model on all
 *    peers and value the snapshot candidates.
 */
export function benchmarkValuation(
  report: SnapshotReport,
  inputOptions: Partial<ValuationOptions> = {},
): ValuationBenchmark {
  const options = resolveValuationOptions(inputOptions);
  const peers = prepareValuationPeers(report);
  if (peers.length < options.folds + 1) {
    throw new ValuationInputError(
      `at least ${options.folds + 1} valuation peers are required for the benchmark`,
    );
  }

  const split = splitValuationPeers(peers, options);
  const selection = selectValuationModel(split.train, options);

  const candidateSpecs = buildCandidateSpecs(options);
  const baselineSpec = candidateSpecs.find(
    (spec) => spec.kind === 'global-median-ratio',
  );
  const categorySpec = candidateSpecs.find(
    (spec) => spec.kind === 'category-median-ratio',
  );
  if (baselineSpec === undefined || categorySpec === undefined) {
    throw new ValuationInputError('baseline candidate specs are missing');
  }

  const baselineCalibration = calibrateValuationModel(
    split.train,
    baselineSpec,
    options,
  );
  const categoryCalibration = calibrateValuationModel(
    split.train,
    categorySpec,
    options,
  );
  const selectedCalibration = calibrateValuationModel(
    split.train,
    selection.selected,
    options,
  );

  const baselineModel = fitValuationModel(split.train, baselineSpec, options);
  const categoryModel = fitValuationModel(split.train, categorySpec, options);
  const selectedModel = fitValuationModel(
    split.train,
    selection.selected,
    options,
  );

  const holdout: HoldoutComparison = Object.freeze({
    sampleN: split.holdout.length,
    targetSlugs: split.holdoutSlugs,
    baseline: evaluateValuationModel(
      baselineModel,
      baselineCalibration,
      split.holdout,
      options,
    ),
    categoryBaseline: evaluateValuationModel(
      categoryModel,
      categoryCalibration,
      split.holdout,
      options,
    ),
    selected: evaluateValuationModel(
      selectedModel,
      selectedCalibration,
      split.holdout,
      options,
    ),
  });

  // Holdout scores are now frozen in the returned object. Refit on all peers
  // only below this line; that final fit is never used for the scores above.
  const finalModel = fitValuationModel(peers, selection.selected, options);
  const valuations = valueCandidates(
    report,
    finalModel,
    peers,
    selectedCalibration,
    options,
  );

  return Object.freeze({
    asOf: report.asOf,
    method: 'cross-sectional-peer-benchmark',
    seed: options.seed,
    options,
    split: Object.freeze({
      strategy: 'deterministic-hash-holdout',
      trainN: split.train.length,
      holdoutN: split.holdout.length,
      trainSlugs: split.trainSlugs,
      holdoutSlugs: split.holdoutSlugs,
    }),
    modelSelection: selection,
    calibrationPool: Object.freeze({
      level: options.intervalLevel,
      folds: options.folds,
      sampleN: split.train.length,
      note:
        'Out-of-fold residuals from training peers only; the holdout is excluded.',
    }),
    holdout,
    final: Object.freeze({
      model: finalModel,
      calibration: selectedCalibration,
      fitSampleN: finalModel.fitSampleN,
      note:
        'Refit on every peer after the holdout scores above were recorded; this fit is not a holdout result.',
    }),
    valuations,
    interpretation: Object.freeze({
      kind: 'cross-sectional-peer-benchmark',
      isLaunchBacktest: false,
      isProbability: false,
      statement:
        'Compares market-cap/TVL structure across tokenized peers in one frozen snapshot. It is not a launch backtest, forecast, or probability of future market cap.',
    }),
    limits: BENCHMARK_LIMITS,
  });
}

export interface DossierSegmentSummary {
  readonly segment: string;
  readonly sampleN: number;
  readonly medianAbsLogError: number;
  readonly coverage: number;
}

export interface DossierMetricSummary {
  readonly sampleN: number;
  readonly medianAbsLogError: number;
  readonly medianAbsolutePercentageError: number;
  readonly medianSignedLogError: number;
  readonly meanSignedLogError: number;
  readonly coverage: number;
  readonly medianIntervalLogWidth: number;
  readonly segments: readonly DossierSegmentSummary[];
}

export interface DossierModelSummary {
  readonly kind: ValuationModelKind;
  readonly fit: RegressionFit | null;
  readonly features: readonly ValuationFeature[];
  readonly categoryShrinkage: number;
  readonly minCategoryN: number;
}

export interface DossierFeatureAblation {
  readonly fit: RegressionFit;
  readonly features: readonly ValuationFeature[];
  readonly bestScore: number;
  readonly bestShrinkage: number;
  readonly deltaVsBase: number;
}

export interface DossierValuationSummary {
  readonly count: number;
  readonly watchlistN: number;
  readonly candidateN: number;
  readonly actualMarketCapN: number;
  readonly tokenStatusCounts: Readonly<Record<string, number>>;
  readonly evidenceFlagCounts: Readonly<Record<string, number>>;
  readonly impliedMarketCapUsd: {
    readonly min: number;
    readonly p10: number;
    readonly median: number;
    readonly p90: number;
    readonly max: number;
  };
  readonly medianIntervalLogWidth: number;
}

export interface DossierSummary {
  readonly asOf: string;
  readonly method: 'cross-sectional-peer-benchmark';
  readonly peerN: number;
  /** Total valuations, including non-watchlist candidates and watchlist rows. */
  readonly valuationN: number;
  readonly watchlistN: number;
  readonly split: {
    readonly trainN: number;
    readonly holdoutN: number;
    readonly holdoutFraction: number;
    readonly seed: string;
  };
  readonly modelSelection: {
    readonly folds: number;
    readonly trainingSampleN: number;
    readonly bestRawScore: number;
    readonly selectedCvScore: number;
    readonly toleranceLog: number;
    readonly selected: DossierModelSummary;
    readonly featureAblation: readonly DossierFeatureAblation[];
  };
  readonly calibration: {
    readonly level: number;
    readonly sampleN: number;
    readonly lowerLogOffset: number;
    readonly upperLogOffset: number;
    readonly coverage: number;
  };
  readonly holdout: {
    readonly sampleN: number;
    readonly baseline: DossierMetricSummary;
    readonly categoryBaseline: DossierMetricSummary;
    readonly selected: DossierMetricSummary;
  };
  readonly final: {
    readonly fitSampleN: number;
    readonly coefficients: readonly number[];
    readonly iterations: number;
    readonly converged: boolean;
    readonly supportedCategoryN: number;
    readonly suppressedCategoryN: number;
  };
  readonly valuations: DossierValuationSummary;
  readonly limits: readonly string[];
}

function dossierMetric(evaluation: ModelEvaluation): DossierMetricSummary {
  return Object.freeze({
    sampleN: evaluation.sampleN,
    medianAbsLogError: evaluation.medianAbsLogError,
    medianAbsolutePercentageError: evaluation.medianAbsolutePercentageError,
    medianSignedLogError: evaluation.medianSignedLogError,
    meanSignedLogError: evaluation.meanSignedLogError,
    coverage: evaluation.coverage,
    medianIntervalLogWidth: evaluation.medianIntervalLogWidth,
    segments: Object.freeze(
      evaluation.segments.map((segment) =>
        Object.freeze({
          segment: segment.segment,
          sampleN: segment.sampleN,
          medianAbsLogError: segment.medianAbsLogError,
          coverage: segment.coverage,
        }),
      ),
    ),
  });
}

function dossierModel(spec: ValuationModelSpec): DossierModelSummary {
  return Object.freeze({
    kind: spec.kind,
    fit: spec.fit,
    features: Object.freeze([...spec.features]),
    categoryShrinkage: spec.categoryShrinkage,
    minCategoryN: spec.minCategoryN,
  });
}

function dossierValuationSummary(
  valuations: readonly TokenValuation[],
): DossierValuationSummary {
  const tokenStatusCounts: Record<string, number> = {
    'already-tokenized': 0,
    'watchlist-unconfirmed': 0,
    candidate: 0,
  };
  const flagCounts = new Map<string, number>();
  let watchlistN = 0;
  let candidateN = 0;
  let actualMarketCapN = 0;
  const marketCaps: number[] = [];

  valuations.forEach((valuation) => {
    tokenStatusCounts[valuation.tokenStatus] =
      (tokenStatusCounts[valuation.tokenStatus] ?? 0) + 1;
    if (valuation.source === 'watchlist') watchlistN += 1;
    else candidateN += 1;
    if (valuation.actualMarketCapUsd !== null) actualMarketCapN += 1;
    marketCaps.push(valuation.impliedMarketCapUsd);
    valuation.evidenceFlags.forEach((flag) => {
      flagCounts.set(flag, (flagCounts.get(flag) ?? 0) + 1);
    });
  });
  marketCaps.sort((left, right) => left - right);

  return Object.freeze({
    count: valuations.length,
    watchlistN,
    candidateN,
    actualMarketCapN,
    tokenStatusCounts: Object.freeze(tokenStatusCounts),
    evidenceFlagCounts: Object.freeze(
      Object.fromEntries(
        [...flagCounts.entries()].sort(([left], [right]) =>
          compareSlugs(left, right),
        ),
      ),
    ),
    impliedMarketCapUsd: Object.freeze({
      min: marketCaps[0] as number,
      p10: quantileSorted(marketCaps, 0.1),
      median: quantileSorted(marketCaps, 0.5),
      p90: quantileSorted(marketCaps, 0.9),
      max: marketCaps[marketCaps.length - 1] as number,
    }),
    medianIntervalLogWidth: median(
      valuations.map((valuation) => valuation.interval.widthLog),
    ),
  });
}

function dossierLimits(intervalLevel: number): readonly string[] {
  const percent = Math.round(intervalLevel * 100);
  return Object.freeze([
    `The ${percent}% band is a global out-of-fold empirical interval, not a precision guarantee or probability.`,
    'Cross-sectional peer benchmark only; not a forecast, launch backtest, or probability of future market cap.',
    'The peer pool is the adapter tokenized partition and can include tokenized CEX, bridge, and liquid-staking categories that are excluded from candidates.',
    'The holdout is a deterministic slug-hash split over this cross-sectional snapshot, not a random sample of token launches.',
    'The final all-peer refit is not scored on the holdout; reported holdout scores come from training-only fits.',
    'Calibration coverage is training out-of-fold coverage and is distinct from held-out interval coverage.',
    'Category offsets are zero below minCategoryN and shrunk on supported categories; sparse categories remain noisy.',
    'Implied market caps are not FDV and depend on the frozen peer snapshot.',
  ]);
}

/**
 * Compact dashboard payload for one dossier. It deliberately drops raw
 * valuation rows, peer examples, records, split slug lists and model IDs. Use
 * the full `ValuationBenchmark` for audits; use this for display/transport.
 */
export function toDossierSummary(
  benchmark: ValuationBenchmark,
): DossierSummary {
  const selected = benchmark.modelSelection.selected;
  const categoryStats = benchmark.final.model.categoryStats;
  const supportedCategoryN = categoryStats.filter(
    (category) => category.supported,
  ).length;
  const suppressedCategoryN = categoryStats.filter(
    (category) => category.belowMinCategoryN,
  ).length;

  return Object.freeze({
    asOf: benchmark.asOf,
    method: benchmark.method,
    peerN: benchmark.final.fitSampleN,
    valuationN: benchmark.valuations.length,
    watchlistN: benchmark.valuations.filter(
      (valuation) => valuation.source === 'watchlist',
    ).length,
    split: Object.freeze({
      trainN: benchmark.split.trainN,
      holdoutN: benchmark.split.holdoutN,
      holdoutFraction: benchmark.options.holdoutFraction,
      seed: benchmark.seed,
    }),
    modelSelection: Object.freeze({
      folds: benchmark.modelSelection.folds,
      trainingSampleN: benchmark.modelSelection.trainingSampleN,
      bestRawScore: benchmark.modelSelection.bestRawScore,
      selectedCvScore: benchmark.modelSelection.selectedCvScore,
      toleranceLog: benchmark.modelSelection.toleranceLog,
      selected: dossierModel(selected),
      featureAblation: Object.freeze(
        benchmark.modelSelection.featureAblation.map((row) =>
          Object.freeze({
            fit: row.fit,
            features: Object.freeze([...row.features]),
            bestScore: row.bestScore,
            bestShrinkage: row.bestShrinkage,
            deltaVsBase: row.deltaVsBase,
          }),
        ),
      ),
    }),
    calibration: Object.freeze({
      level: benchmark.calibrationPool.level,
      sampleN: benchmark.calibrationPool.sampleN,
      lowerLogOffset: benchmark.final.calibration.lowerLogOffset,
      upperLogOffset: benchmark.final.calibration.upperLogOffset,
      coverage: benchmark.final.calibration.coverage,
    }),
    holdout: Object.freeze({
      sampleN: benchmark.holdout.sampleN,
      baseline: dossierMetric(benchmark.holdout.baseline),
      categoryBaseline: dossierMetric(benchmark.holdout.categoryBaseline),
      selected: dossierMetric(benchmark.holdout.selected),
    }),
    final: Object.freeze({
      fitSampleN: benchmark.final.fitSampleN,
      coefficients: Object.freeze([...benchmark.final.model.coefficients]),
      iterations: benchmark.final.model.iterations,
      converged: benchmark.final.model.converged,
      supportedCategoryN,
      suppressedCategoryN,
    }),
    valuations: dossierValuationSummary(benchmark.valuations),
    limits: dossierLimits(benchmark.calibrationPool.level),
  });
}
