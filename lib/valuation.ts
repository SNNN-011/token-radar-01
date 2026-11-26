/**
 * Deterministic cross-sectional Token Radar valuation core.
 *
 * This module estimates an implied MARKET CAP (never FDV) for a token-less
 * protocol by comparing it with tokenized peers in one frozen DefiLlama
 * snapshot. Two transparent baselines and one scale-aware partially pooled
 * model are supported:
 *
 * - `global-median-ratio`: peer median of log(marketCap / TVL), i.e. the
 *   geometric median market-cap-to-TVL ratio.
 * - `category-median-ratio`: per-category median log ratio with a global
 *   fallback when a category has fewer than `minCategoryN` peers.
 * - `scale-partially-pooled`: log-log regression on log(TVL), optional capped
 *   7d TVL change and capped age, plus per-category median residuals shrunk
 *   toward zero by n / (n + k) only when the category has at least
 *   `minCategoryN` peers; below that threshold the offset is zero and the
 *   category carries an explicit suppression diagnostic.
 *
 * Public candidate output also carries a neutral `tokenStatus`: a watchlist row
 * already backed by a usable market cap or gecko id is `already-tokenized`,
 * other watchlist rows are `watchlist-unconfirmed` (never claimed as pre-token),
 * and non-watchlist tokenless rows are `candidate`.
 *
 * Nothing here is a launch backtest or a probability. A point estimate is a
 * cross-sectional benchmark; an interval is an empirical quantile band built
 * from out-of-fold peer residuals.
 *
 * Determinism and loop discipline: all ordering is by exact slug codepoints,
 * random-looking splits are SHA-256 hashes of the slug, and every loop is a
 * bounded array operation or a explicitly capped Huber iteration. No mutable
 * module state is retained.
 */

import { createHash } from 'node:crypto';

import type { SnapshotReport } from './snapshot.ts';

export type ValuationModelKind =
  | 'global-median-ratio'
  | 'category-median-ratio'
  | 'scale-partially-pooled';

export type ValuationFeature = 'change7d' | 'age';

export type RegressionFit = 'ols' | 'huber';

export interface ValuationPeer {
  readonly slug: string;
  readonly category: string | null;
  readonly tvlUsd: number;
  readonly marketCapUsd: number;
  readonly change7d: number | null;
  readonly ageDays: number | null;
}

export interface ValuationTarget {
  readonly slug: string;
  readonly category: string | null;
  readonly tvlUsd: number;
  readonly change7d: number | null;
  readonly ageDays: number | null;
  readonly watchlist?: boolean;
  /** Strong token evidence carried from the snapshot ledger. */
  readonly alreadyTokenized?: boolean;
  /** Actual market cap when one exists; null when tokenized without an mcap. */
  readonly actualMarketCapUsd?: number | null;
}

export interface ValuationModelSpec {
  readonly id: string;
  readonly kind: ValuationModelKind;
  readonly fit: RegressionFit | null;
  readonly features: readonly ValuationFeature[];
  readonly categoryShrinkage: number;
  readonly minCategoryN: number;
}

export interface CategoryStat {
  readonly category: string;
  readonly n: number;
  /** True when n >= minCategoryN; false means no category adjustment. */
  readonly supported: boolean;
  /** True when support is below minCategoryN. */
  readonly belowMinCategoryN: boolean;
  /** Median log(marketCap / TVL) for category baselines; null when unsupported. */
  readonly medianLogRatio: number | null;
  /** Median residual from the global regression, before shrinkage. */
  readonly residualMedianLog: number | null;
  /** Shrunken additive log offset applied by the scale-aware model. */
  readonly offsetLog: number;
  /** True only when the offset is actually applied (supported category). */
  readonly offsetApplied: boolean;
  /** n / (n + categoryShrinkage), or zero when support is below minCategoryN. */
  readonly weight: number;
}

export interface FittedValuationModel {
  readonly spec: ValuationModelSpec;
  readonly fitSlugs: readonly string[];
  readonly fitSampleN: number;
  readonly logTvlMin: number;
  readonly logTvlMax: number;
  readonly tvlQuartilesLog: readonly [number, number, number];
  readonly marketCapP90Usd: number;
  readonly globalMedianLogRatio: number;
  /** [intercept, logTvl, ...feature coefficients in spec.features order]. */
  readonly coefficients: readonly number[];
  readonly imputationMeans: {
    readonly changeUnits: number;
    readonly ageYears: number;
  };
  readonly categoryStats: readonly CategoryStat[];
  readonly iterations: number;
  readonly converged: boolean;
}

export interface IntervalCalibration {
  readonly level: number;
  readonly sampleN: number;
  readonly lowerLogOffset: number;
  readonly upperLogOffset: number;
  readonly medianAbsLogError: number;
  readonly coverage: number;
}

export type ValuationEvidenceFlag =
  | 'global-median-ratio'
  | 'category-median-ratio'
  | 'category-median-fallback'
  | 'category-partially-pooled'
  | 'category-unseen'
  | 'sparse-category'
  | 'category-offset-suppressed'
  | 'category-adjustment-large'
  | 'tvl-below-fit-range'
  | 'tvl-above-fit-range'
  | 'missing-change-7d'
  | 'missing-listed-at'
  | 'interval-wide'
  | 'small-calibration-sample';

export type ValuationTokenStatus =
  | 'already-tokenized'
  | 'watchlist-unconfirmed'
  | 'candidate';

export interface PeerExample {
  readonly slug: string;
  readonly category: string | null;
  readonly tvlUsd: number;
  readonly marketCapUsd: number;
  readonly marketCapToTvlRatio: number;
  readonly sameCategory: boolean;
  readonly logTvlDistance: number;
}

export interface TokenValuation {
  readonly slug: string;
  readonly category: string | null;
  readonly tvlUsd: number;
  readonly source: 'watchlist' | 'candidate';
  readonly tokenStatus: ValuationTokenStatus;
  readonly actualMarketCapUsd: number | null;
  readonly pointBasis: 'market-cap';
  readonly impliedMarketCapUsd: number;
  readonly impliedLogMarketCap: number;
  readonly interval: {
    readonly level: number;
    readonly lowUsd: number;
    readonly highUsd: number;
    readonly lowLog: number;
    readonly highLog: number;
    readonly widthLog: number;
  };
  readonly peerCategoryN: number;
  readonly peerPoolN: number;
  readonly peerExamples: readonly PeerExample[];
  readonly modelId: string;
  readonly evidenceFlags: readonly ValuationEvidenceFlag[];
}

export interface ValuationSplit {
  readonly seed: string;
  readonly holdoutFraction: number;
  readonly train: readonly ValuationPeer[];
  readonly holdout: readonly ValuationPeer[];
  readonly trainSlugs: readonly string[];
  readonly holdoutSlugs: readonly string[];
}

export interface ValuationOptions {
  readonly seed: string;
  readonly holdoutFraction: number;
  readonly folds: number;
  readonly intervalLevel: number;
  readonly minCategoryN: number;
  readonly maxPeerExamples: number;
  readonly categoryShrinkageGrid: readonly number[];
  readonly selectionToleranceLog: number;
  readonly wideIntervalLogWidth: number;
  readonly huberDelta: number;
  readonly huberMaxIterations: number;
  readonly huberTolerance: number;
  readonly changeCapPercent: number;
  readonly ageCapYears: number;
}

export const DEFAULT_VALUATION_OPTIONS: ValuationOptions = Object.freeze({
  seed: 'token-radar-valuation-v1',
  holdoutFraction: 0.3,
  folds: 5,
  intervalLevel: 0.8,
  minCategoryN: 3,
  maxPeerExamples: 5,
  categoryShrinkageGrid: Object.freeze([0, 1, 2, 5, 10, 20, 40]),
  selectionToleranceLog: 0.02,
  wideIntervalLogWidth: 3,
  huberDelta: 1.345,
  huberMaxIterations: 30,
  huberTolerance: 1e-10,
  changeCapPercent: 50,
  ageCapYears: 5,
});

export class ValuationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValuationInputError';
  }
}

export class ValuationOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValuationOptionsError';
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertPositive(value: unknown, name: string): number {
  if (!isFiniteNumber(value) || value <= 0) {
    throw new ValuationOptionsError(
      `Valuation option ${name} must be a positive finite number`,
    );
  }
  return value;
}

function assertInteger(value: unknown, name: string, minimum: number): number {
  if (
    !isFiniteNumber(value) ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new ValuationOptionsError(
      `Valuation option ${name} must be an integer >= ${minimum}`,
    );
  }
  return value;
}

export function resolveValuationOptions(
  input: Partial<ValuationOptions> = {},
): ValuationOptions {
  const merged: ValuationOptions = { ...DEFAULT_VALUATION_OPTIONS, ...input };

  if (typeof merged.seed !== 'string' || merged.seed.length === 0) {
    throw new ValuationOptionsError(
      'Valuation option seed must be a non-empty string',
    );
  }
  if (
    !isFiniteNumber(merged.holdoutFraction) ||
    merged.holdoutFraction <= 0 ||
    merged.holdoutFraction >= 1
  ) {
    throw new ValuationOptionsError(
      'Valuation option holdoutFraction must be strictly between 0 and 1',
    );
  }
  assertInteger(merged.folds, 'folds', 2);
  if (
    !isFiniteNumber(merged.intervalLevel) ||
    merged.intervalLevel <= 0 ||
    merged.intervalLevel >= 1
  ) {
    throw new ValuationOptionsError(
      'Valuation option intervalLevel must be strictly between 0 and 1',
    );
  }
  assertInteger(merged.minCategoryN, 'minCategoryN', 1);
  assertInteger(merged.maxPeerExamples, 'maxPeerExamples', 1);
  if (
    !Array.isArray(merged.categoryShrinkageGrid) ||
    merged.categoryShrinkageGrid.length === 0
  ) {
    throw new ValuationOptionsError(
      'Valuation option categoryShrinkageGrid must be a non-empty array',
    );
  }
  merged.categoryShrinkageGrid.forEach((value, index) => {
    if (!isFiniteNumber(value) || value < 0) {
      throw new ValuationOptionsError(
        `Valuation option categoryShrinkageGrid[${index}] must be a finite number >= 0`,
      );
    }
  });
  if (
    !isFiniteNumber(merged.selectionToleranceLog) ||
    merged.selectionToleranceLog < 0
  ) {
    throw new ValuationOptionsError(
      'Valuation option selectionToleranceLog must be a finite number >= 0',
    );
  }
  assertPositive(merged.wideIntervalLogWidth, 'wideIntervalLogWidth');
  assertPositive(merged.huberDelta, 'huberDelta');
  assertInteger(merged.huberMaxIterations, 'huberMaxIterations', 1);
  assertPositive(merged.huberTolerance, 'huberTolerance');
  assertPositive(merged.changeCapPercent, 'changeCapPercent');
  assertPositive(merged.ageCapYears, 'ageCapYears');

  return Object.freeze({
    ...merged,
    categoryShrinkageGrid: Object.freeze([...merged.categoryShrinkageGrid]),
  });
}

function compareSlugs(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertPeer(peerValue: ValuationPeer, index: number): void {
  if (
    typeof peerValue.slug !== 'string' ||
    peerValue.slug.length === 0 ||
    peerValue.slug.trim() !== peerValue.slug
  ) {
    throw new ValuationInputError(
      `peer[${index}].slug must be an exact, non-blank string`,
    );
  }
  if (!isFiniteNumber(peerValue.tvlUsd) || peerValue.tvlUsd <= 0) {
    throw new ValuationInputError(
      `${peerValue.slug}.tvlUsd must be a positive finite number`,
    );
  }
  if (
    !isFiniteNumber(peerValue.marketCapUsd) ||
    peerValue.marketCapUsd <= 0
  ) {
    throw new ValuationInputError(
      `${peerValue.slug}.marketCapUsd must be a positive finite number`,
    );
  }
  if (peerValue.category !== null && typeof peerValue.category !== 'string') {
    throw new ValuationInputError(
      `${peerValue.slug}.category must be a string or null`,
    );
  }
  if (
    peerValue.change7d !== null &&
    !isFiniteNumber(peerValue.change7d)
  ) {
    throw new ValuationInputError(
      `${peerValue.slug}.change7d must be a finite number or null`,
    );
  }
  if (
    peerValue.ageDays !== null &&
    (!isFiniteNumber(peerValue.ageDays) || peerValue.ageDays < 0)
  ) {
    throw new ValuationInputError(
      `${peerValue.slug}.ageDays must be a non-negative finite number or null`,
    );
  }
}

function assertUniqueSlugs(peers: readonly ValuationPeer[]): void {
  const seen = new Set<string>();
  peers.forEach((peerValue) => {
    if (seen.has(peerValue.slug)) {
      throw new ValuationInputError(
        `duplicate valuation peer slug "${peerValue.slug}"`,
      );
    }
    seen.add(peerValue.slug);
  });
}

function utcDayNumber(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) {
    throw new ValuationInputError(`invalid UTC date "${date}"`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const stamp = Date.UTC(year, month - 1, day);
  const check = new Date(stamp);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new ValuationInputError(`invalid UTC date "${date}"`);
  }
  return stamp / 86_400_000;
}

/**
 * Adapt the validated snapshot's tokenized peers into the valuation contract.
 * TVL must be positive because every model is a market-cap-to-TVL benchmark.
 */
export function prepareValuationPeers(
  report: SnapshotReport,
): readonly ValuationPeer[] {
  const asOfDay = utcDayNumber(report.asOf);
  const prepared = report.peers.map((row, index): ValuationPeer => {
    const token = row.token;
    const tvlUsd = token.tvlUsd;
    const marketCapUsd = token.marketCapUsd;

    if (!isFiniteNumber(tvlUsd) || tvlUsd <= 0) {
      throw new ValuationInputError(
        `${row.slug}.tvlUsd must be a positive finite number for valuation`,
      );
    }
    if (!isFiniteNumber(marketCapUsd) || marketCapUsd <= 0) {
      throw new ValuationInputError(
        `${row.slug}.marketCapUsd must be a positive finite number for valuation`,
      );
    }

    let ageDays: number | null = null;
    if (typeof token.listedAt === 'string' && token.listedAt.trim().length > 0) {
      const listedDay = utcDayNumber(token.listedAt);
      if (listedDay > asOfDay) {
        throw new ValuationInputError(
          `${row.slug}.listedAt is after the snapshot asOf date`,
        );
      }
      ageDays = asOfDay - listedDay;
    }

    const peerValue: ValuationPeer = {
      slug: row.slug,
      category:
        typeof token.category === 'string' && token.category.length > 0
          ? token.category
          : null,
      tvlUsd,
      marketCapUsd,
      change7d:
        typeof token.change7d === 'number' && Number.isFinite(token.change7d)
          ? token.change7d
          : null,
      ageDays,
    };
    assertPeer(peerValue, index);
    return Object.freeze(peerValue);
  });

  assertUniqueSlugs(prepared);
  return Object.freeze(
    prepared.sort((left, right) => compareSlugs(left.slug, right.slug)),
  );
}

function slugHash(seed: string, purpose: string, slug: string): string {
  return createHash('sha256')
    .update(`${seed}\u0000${purpose}\u0000${slug}`)
    .digest('hex');
}

/**
 * Deterministic holdout split: peers are ordered by SHA-256(seed, slug) and the
 * first `round(n * holdoutFraction)` are held out. Input order cannot change
 * membership; ties are impossible in practice but still broken by slug.
 */
export function splitValuationPeers(
  peers: readonly ValuationPeer[],
  inputOptions: Partial<ValuationOptions> = {},
): ValuationSplit {
  const resolved = resolveValuationOptions(inputOptions);
  if (peers.length < 2) {
    throw new ValuationInputError(
      'at least two valuation peers are required for a split',
    );
  }
  peers.forEach(assertPeer);
  assertUniqueSlugs(peers);

  const sorted = [...peers].sort((left, right) => compareSlugs(left.slug, right.slug));
  const hashed = [...sorted].sort((left, right) => {
    const leftKey = slugHash(resolved.seed, 'split', left.slug);
    const rightKey = slugHash(resolved.seed, 'split', right.slug);
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    return compareSlugs(left.slug, right.slug);
  });

  const holdoutN = Math.max(
    1,
    Math.min(sorted.length - 1, Math.round(sorted.length * resolved.holdoutFraction)),
  );
  const holdout = hashed.slice(0, holdoutN);
  const train = hashed.slice(holdoutN);

  return Object.freeze({
    seed: resolved.seed,
    holdoutFraction: resolved.holdoutFraction,
    train: Object.freeze([...train].sort((left, right) => compareSlugs(left.slug, right.slug))),
    holdout: Object.freeze(
      [...holdout].sort((left, right) => compareSlugs(left.slug, right.slug)),
    ),
    trainSlugs: Object.freeze(train.map((entry) => entry.slug).sort(compareSlugs)),
    holdoutSlugs: Object.freeze(
      holdout.map((entry) => entry.slug).sort(compareSlugs),
    ),
  });
}

export function quantileSorted(
  sortedValues: readonly number[],
  probability: number,
): number {
  if (sortedValues.length === 0) {
    throw new ValuationInputError('quantile of an empty sample');
  }
  if (!isFiniteNumber(probability) || probability < 0 || probability > 1) {
    throw new ValuationInputError('quantile probability must be in [0, 1]');
  }
  if (sortedValues.length === 1) return sortedValues[0] as number;

  const position = (sortedValues.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sortedValues[lower] as number;
  const upperValue = sortedValues[upper] as number;
  if (lower === upper) return lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new ValuationInputError('median of an empty sample');
  }
  const sorted = [...values].sort((left, right) => left - right);
  return quantileSorted(sorted, 0.5);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function canonicalFeatures(
  features: readonly ValuationFeature[],
): readonly ValuationFeature[] {
  const seen = new Set<string>();
  features.forEach((feature) => {
    if (feature !== 'change7d' && feature !== 'age') {
      throw new ValuationInputError(
        `unsupported valuation feature "${String(feature)}"`,
      );
    }
    if (seen.has(feature)) {
      throw new ValuationInputError(
        `duplicate valuation feature "${feature}"`,
      );
    }
    seen.add(feature);
  });
  return Object.freeze(
    (['change7d', 'age'] as const).filter((feature) => seen.has(feature)),
  );
}

function changeFeature(
  change7d: number | null,
  imputationMean: number,
  capPercent: number,
): number {
  if (change7d === null) return imputationMean;
  const capped = Math.max(-capPercent, Math.min(capPercent, change7d));
  return capped / 10;
}

function ageFeature(
  ageDays: number | null,
  imputationMean: number,
  capYears: number,
): number {
  if (ageDays === null) return imputationMean;
  return Math.min(Math.max(ageDays, 0) / 365.25, capYears);
}

function featureValue(
  target: Pick<ValuationTarget, 'change7d' | 'ageDays'>,
  feature: ValuationFeature,
  model: Pick<
    FittedValuationModel,
    'imputationMeans' | 'spec'
  >,
  options: ValuationOptions,
): number {
  if (feature === 'change7d') {
    return changeFeature(
      target.change7d,
      model.imputationMeans.changeUnits,
      options.changeCapPercent,
    );
  }
  return ageFeature(
    target.ageDays,
    model.imputationMeans.ageYears,
    options.ageCapYears,
  );
}

interface DesignRow {
  readonly slug: string;
  readonly category: string | null;
  readonly x: readonly number[];
  readonly y: number;
}

function solveLinearSystem(
  matrix: readonly (readonly number[])[],
  vector: readonly number[],
): readonly number[] {
  const size = matrix.length;
  const augmented = matrix.map((row, index) => [
    ...row,
    vector[index] as number,
  ]);

  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row += 1) {
      if (
        Math.abs(augmented[row]?.[column] as number) >
        Math.abs(augmented[pivotRow]?.[column] as number)
      ) {
        pivotRow = row;
      }
    }
    const pivot = augmented[pivotRow]?.[column] as number;
    if (!Number.isFinite(pivot) || Math.abs(pivot) < 1e-12) {
      throw new ValuationInputError(
        'valuation regression is singular; features may be constant',
      );
    }
    const swap = augmented[column] as number[];
    augmented[column] = augmented[pivotRow] as number[];
    augmented[pivotRow] = swap;

    for (let row = column + 1; row < size; row += 1) {
      const factor =
        (augmented[row]?.[column] as number) /
        (augmented[column]?.[column] as number);
      for (let entry = column; entry <= size; entry += 1) {
        (augmented[row] as number[])[entry] =
          (augmented[row]?.[entry] as number) -
          factor * (augmented[column]?.[entry] as number);
      }
    }
  }

  const solution = new Array<number>(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let value = augmented[row]?.[size] as number;
    for (let column = row + 1; column < size; column += 1) {
      value -= (augmented[row]?.[column] as number) * (solution[column] as number);
    }
    solution[row] = value / (augmented[row]?.[row] as number);
  }
  if (!solution.every((value) => Number.isFinite(value))) {
    throw new ValuationInputError(
      'valuation regression produced non-finite coefficients',
    );
  }
  return solution;
}

function weightedLeastSquares(
  rows: readonly DesignRow[],
  weights: readonly number[],
): readonly number[] {
  const width = rows[0]?.x.length ?? 0;
  const matrix = Array.from({ length: width }, () =>
    new Array<number>(width).fill(0),
  );
  const vector = new Array<number>(width).fill(0);

  rows.forEach((row, rowIndex) => {
    const weight = weights[rowIndex] as number;
    row.x.forEach((value, left) => {
      vector[left] = (vector[left] as number) + weight * value * row.y;
      for (let right = left; right < width; right += 1) {
        (matrix[left] as number[])[right] =
          (matrix[left]?.[right] as number) +
          weight * value * (row.x[right] as number);
      }
    });
  });

  for (let left = 0; left < width; left += 1) {
    for (let right = 0; right < left; right += 1) {
      (matrix[left] as number[])[right] = (matrix[right]?.[left] as number);
    }
  }
  // A tiny ridge keeps an all-missing or constant ablation feature solvable
  // without materially changing a well-identified fit.
  for (let index = 0; index < width; index += 1) {
    (matrix[index] as number[])[index] =
      (matrix[index]?.[index] as number) + 1e-9;
  }

  return solveLinearSystem(matrix, vector);
}

function ordinaryLeastSquares(rows: readonly DesignRow[]): readonly number[] {
  return weightedLeastSquares(
    rows,
    rows.map(() => 1),
  );
}

interface LinearFitResult {
  readonly coefficients: readonly number[];
  readonly iterations: number;
  readonly converged: boolean;
}

function huberLeastSquares(
  rows: readonly DesignRow[],
  options: ValuationOptions,
): LinearFitResult {
  const start = ordinaryLeastSquares(rows);
  if (!start.every((value) => Number.isFinite(value))) {
    throw new ValuationInputError('Huber start coefficients are not finite');
  }

  let coefficients = start;
  let converged = false;
  let iterations = 0;

  for (let iteration = 1; iteration <= options.huberMaxIterations; iteration += 1) {
    iterations = iteration;
    const residuals = rows.map(
      (row) =>
        row.y -
        row.x.reduce(
          (total, value, index) => total + value * (coefficients[index] as number),
          0,
        ),
    );
    const absolute = residuals.map((value) => Math.abs(value));
    const scale = 1.4826 * median(absolute);
    if (!Number.isFinite(scale) || scale < 1e-12) {
      converged = true;
      break;
    }
    const cutoff = options.huberDelta * scale;
    const weights = residuals.map((value) =>
      Math.abs(value) <= cutoff ? 1 : cutoff / Math.abs(value),
    );
    const next = weightedLeastSquares(rows, weights);
    const delta = Math.max(
      ...next.map((value, index) =>
        Math.abs(value - (coefficients[index] as number)),
      ),
    );
    coefficients = next;
    if (delta < options.huberTolerance) {
      converged = true;
      break;
    }
  }

  return Object.freeze({ coefficients, iterations, converged });
}

function buildDesignRows(
  peers: readonly ValuationPeer[],
  features: readonly ValuationFeature[],
  imputationMeans: FittedValuationModel['imputationMeans'],
  options: ValuationOptions,
): readonly DesignRow[] {
  return peers.map((peerValue) => {
    const logTvl = Math.log(peerValue.tvlUsd);
    const values = [1, logTvl];
    features.forEach((feature) => {
      values.push(
        feature === 'change7d'
          ? changeFeature(
              peerValue.change7d,
              imputationMeans.changeUnits,
              options.changeCapPercent,
            )
          : ageFeature(
              peerValue.ageDays,
              imputationMeans.ageYears,
              options.ageCapYears,
            ),
      );
    });
    return {
      slug: peerValue.slug,
      category: peerValue.category,
      x: values,
      y: Math.log(peerValue.marketCapUsd),
    };
  });
}

function categoryResidualStats(
  rows: readonly DesignRow[],
  coefficients: readonly number[],
  shrinkage: number,
  minCategoryN: number,
): readonly CategoryStat[] {
  const grouped = new Map<string, number[]>();
  rows.forEach((row) => {
    const category = row.category ?? '(uncategorized)';
    const prediction = row.x.reduce(
      (total, value, index) => total + value * (coefficients[index] as number),
      0,
    );
    const residuals = grouped.get(category) ?? [];
    residuals.push(row.y - prediction);
    grouped.set(category, residuals);
  });

  return Object.freeze(
    [...grouped.entries()]
      .sort(([left], [right]) => compareSlugs(left, right))
      .map(([category, residuals]) => {
        const n = residuals.length;
        const supported = n >= minCategoryN;
        const residualMedian = median(residuals);
        const weight = supported ? n / (n + shrinkage) : 0;
        return Object.freeze({
          category,
          n,
          supported,
          belowMinCategoryN: !supported,
          medianLogRatio: null,
          residualMedianLog: residualMedian,
          offsetLog: supported ? weight * residualMedian : 0,
          offsetApplied: supported,
          weight,
        });
      }),
  );
}

function categoryMedianStats(
  peers: readonly ValuationPeer[],
  globalMedianLogRatio: number,
  minCategoryN: number,
): readonly CategoryStat[] {
  const grouped = new Map<string, number[]>();
  peers.forEach((peerValue) => {
    const category = peerValue.category ?? '(uncategorized)';
    const ratios = grouped.get(category) ?? [];
    ratios.push(
      Math.log(peerValue.marketCapUsd) - Math.log(peerValue.tvlUsd),
    );
    grouped.set(category, ratios);
  });

  return Object.freeze(
    [...grouped.entries()]
      .sort(([left], [right]) => compareSlugs(left, right))
      .map(([category, ratios]) => {
        const supported = ratios.length >= minCategoryN;
        return Object.freeze({
          category,
          n: ratios.length,
          supported,
          belowMinCategoryN: !supported,
          medianLogRatio: supported ? median(ratios) : null,
          residualMedianLog: null,
          offsetLog: 0,
          offsetApplied: false,
          weight: 0,
        });
      }),
  );
}

function findCategoryStat(
  model: FittedValuationModel,
  category: string | null,
): CategoryStat | undefined {
  const key = category ?? '(uncategorized)';
  return model.categoryStats.find((entry) => entry.category === key);
}

/**
 * Fit one declared model. Only the passed peers are used; the caller is
 * responsible for keeping validation/holdout separation.
 */
export function fitValuationModel(
  peers: readonly ValuationPeer[],
  spec: ValuationModelSpec,
  inputOptions: Partial<ValuationOptions> = {},
): FittedValuationModel {
  const resolved = resolveValuationOptions(inputOptions);
  if (peers.length === 0) {
    throw new ValuationInputError(
      'at least one valuation peer is required to fit a model',
    );
  }
  peers.forEach(assertPeer);
  assertUniqueSlugs(peers);

  const features = canonicalFeatures(spec.features);
  if (
    spec.kind !== 'scale-partially-pooled' &&
    (spec.fit !== null || features.length > 0 || spec.categoryShrinkage !== 0)
  ) {
    throw new ValuationInputError(
      `${spec.id}: baseline models cannot declare regression features, fit or shrinkage`,
    );
  }
  if (
    spec.kind === 'scale-partially-pooled' &&
    (spec.fit === null || (spec.fit !== 'ols' && spec.fit !== 'huber'))
  ) {
    throw new ValuationInputError(
      `${spec.id}: scale model requires an ols or huber fit`,
    );
  }
  if (
    !isFiniteNumber(spec.categoryShrinkage) ||
    spec.categoryShrinkage < 0
  ) {
    throw new ValuationInputError(
      `${spec.id}: categoryShrinkage must be a finite number >= 0`,
    );
  }
  if (
    !isFiniteNumber(spec.minCategoryN) ||
    !Number.isSafeInteger(spec.minCategoryN) ||
    spec.minCategoryN < 1
  ) {
    throw new ValuationInputError(
      `${spec.id}: minCategoryN must be an integer >= 1`,
    );
  }

  const sorted = [...peers].sort((left, right) =>
    compareSlugs(left.slug, right.slug),
  );
  const logTvls = sorted.map((peerValue) => Math.log(peerValue.tvlUsd));
  const logRatios = sorted.map(
    (peerValue) =>
      Math.log(peerValue.marketCapUsd) - Math.log(peerValue.tvlUsd),
  );
  const globalMedianLogRatio = median(logRatios);
  const sortedLogTvls = [...logTvls].sort((left, right) => left - right);
  const sortedMarketCaps = sorted
    .map((peerValue) => peerValue.marketCapUsd)
    .sort((left, right) => left - right);

  const changeValues = sorted
    .map((peerValue) => peerValue.change7d)
    .filter((value): value is number => value !== null)
    .map((value) =>
      changeFeature(value, 0, resolved.changeCapPercent),
    );
  const ageValues = sorted
    .map((peerValue) => peerValue.ageDays)
    .filter((value): value is number => value !== null)
    .map((value) => ageFeature(value, 0, resolved.ageCapYears));
  const imputationMeans = Object.freeze({
    changeUnits: mean(changeValues),
    ageYears: mean(ageValues),
  });

  const shared = {
    spec: Object.freeze({
      ...spec,
      features: Object.freeze([...features]),
    }),
    fitSlugs: Object.freeze(sorted.map((peerValue) => peerValue.slug)),
    fitSampleN: sorted.length,
    logTvlMin: sortedLogTvls[0] as number,
    logTvlMax: sortedLogTvls[sortedLogTvls.length - 1] as number,
    tvlQuartilesLog: Object.freeze([
      quantileSorted(sortedLogTvls, 0.25),
      quantileSorted(sortedLogTvls, 0.5),
      quantileSorted(sortedLogTvls, 0.75),
    ]) as readonly [number, number, number],
    marketCapP90Usd: quantileSorted(sortedMarketCaps, 0.9),
    globalMedianLogRatio,
    imputationMeans,
  };

  if (spec.kind === 'global-median-ratio') {
    return Object.freeze({
      ...shared,
      coefficients: Object.freeze([globalMedianLogRatio, 1]),
      categoryStats: Object.freeze([] as CategoryStat[]),
      iterations: 0,
      converged: true,
    });
  }

  if (spec.kind === 'category-median-ratio') {
    return Object.freeze({
      ...shared,
      coefficients: Object.freeze([globalMedianLogRatio, 1]),
      categoryStats: categoryMedianStats(
        sorted,
        globalMedianLogRatio,
        spec.minCategoryN,
      ),
      iterations: 0,
      converged: true,
    });
  }

  const rows = buildDesignRows(
    sorted,
    features,
    imputationMeans,
    resolved,
  );
  const linear: LinearFitResult =
    spec.fit === 'huber'
      ? huberLeastSquares(rows, resolved)
      : Object.freeze({
          coefficients: ordinaryLeastSquares(rows),
          iterations: 0,
          converged: true,
        });

  return Object.freeze({
    ...shared,
    coefficients: Object.freeze([...linear.coefficients]),
    categoryStats: categoryResidualStats(
      rows,
      linear.coefficients,
      spec.categoryShrinkage,
      spec.minCategoryN,
    ),
    iterations: linear.iterations,
    converged: linear.converged,
  });
}

function assertPositiveTargetTvl(target: ValuationTarget): number {
  if (!isFiniteNumber(target.tvlUsd) || target.tvlUsd <= 0) {
    throw new ValuationInputError(
      `${target.slug}.tvlUsd must be a positive finite number`,
    );
  }
  return Math.log(target.tvlUsd);
}

/**
 * Predict log(implied market cap). The point is a market-cap benchmark, not
 * FDV and not a probability.
 */
export function predictLogMarketCap(
  model: FittedValuationModel,
  target: ValuationTarget,
  inputOptions: Partial<ValuationOptions> = {},
): number {
  const resolved = resolveValuationOptions(inputOptions);
  const logTvl = assertPositiveTargetTvl(target);
  let prediction: number;

  if (model.spec.kind === 'global-median-ratio') {
    prediction = (model.coefficients[0] as number) + logTvl;
  } else if (model.spec.kind === 'category-median-ratio') {
    const category = findCategoryStat(model, target.category);
    const ratio = category?.medianLogRatio ?? model.globalMedianLogRatio;
    prediction = ratio + logTvl;
  } else {
    prediction = (model.coefficients[0] as number);
    prediction += (model.coefficients[1] as number) * logTvl;
    model.spec.features.forEach((feature, index) => {
      prediction +=
        (model.coefficients[index + 2] as number) *
        featureValue(target, feature, model, resolved);
    });
    const category = findCategoryStat(model, target.category);
    prediction += category?.offsetLog ?? 0;
  }

  if (!Number.isFinite(prediction)) {
    throw new ValuationInputError(
      `${target.slug}: valuation prediction is not finite`,
    );
  }
  return prediction;
}

function roundUsd(value: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded) || rounded < 0) {
    throw new ValuationInputError('valuation produced an unusable USD amount');
  }
  return rounded;
}

function evidenceFlagsFor(
  target: ValuationTarget,
  model: FittedValuationModel,
  calibration: IntervalCalibration,
  logTvl: number,
  widthLog: number,
  options: ValuationOptions,
): readonly ValuationEvidenceFlag[] {
  const flags: ValuationEvidenceFlag[] = [];
  const category = findCategoryStat(model, target.category);

  if (model.spec.kind === 'global-median-ratio') {
    flags.push('global-median-ratio');
  } else if (model.spec.kind === 'category-median-ratio') {
    if (category !== undefined && category.medianLogRatio !== null) {
      flags.push('category-median-ratio');
    } else {
      flags.push('category-median-fallback');
      if (category === undefined) flags.push('category-unseen');
    }
  } else {
    if (category === undefined) {
      flags.push('category-unseen');
    } else if (category.offsetApplied) {
      flags.push('category-partially-pooled');
    }
  }

  if (
    category !== undefined &&
    category.n < model.spec.minCategoryN &&
    model.spec.kind !== 'global-median-ratio'
  ) {
    flags.push('sparse-category');
  }
  if (
    model.spec.kind === 'scale-partially-pooled' &&
    category !== undefined &&
    category.offsetApplied === false
  ) {
    flags.push('category-offset-suppressed');
  }
  if (category !== undefined && Math.abs(category.offsetLog) >= 1) {
    flags.push('category-adjustment-large');
  }
  if (logTvl < model.logTvlMin) flags.push('tvl-below-fit-range');
  if (logTvl > model.logTvlMax) flags.push('tvl-above-fit-range');
  if (model.spec.features.includes('change7d') && target.change7d === null) {
    flags.push('missing-change-7d');
  }
  if (model.spec.features.includes('age') && target.ageDays === null) {
    flags.push('missing-listed-at');
  }
  if (widthLog > options.wideIntervalLogWidth) flags.push('interval-wide');
  if (calibration.sampleN < 30) flags.push('small-calibration-sample');

  return Object.freeze(flags);
}

/**
 * Enforce that the public evidence pool is exactly the model's fit set. This
 * prevents a caller from attaching unrelated peers to a frozen model.
 */
function validateEvidencePeerSet(
  model: FittedValuationModel,
  peers: readonly ValuationPeer[],
): ReadonlySet<string> {
  if (peers.length === 0) {
    throw new ValuationInputError(
      'at least one peer is required to produce peer evidence',
    );
  }
  peers.forEach(assertPeer);
  assertUniqueSlugs(peers);

  if (peers.length !== model.fitSlugs.length) {
    throw new ValuationInputError(
      `valuation requires the exact fit peer set (${model.fitSlugs.length} peers), received ${peers.length}`,
    );
  }
  const fitSlugs = new Set(model.fitSlugs);
  const peerSlugs = new Set(peers.map((peerValue) => peerValue.slug));
  if (
    peerSlugs.size !== peers.length ||
    fitSlugs.size !== model.fitSlugs.length ||
    [...peerSlugs].some((slug) => !fitSlugs.has(slug)) ||
    model.fitSlugs.some((slug) => !peerSlugs.has(slug))
  ) {
    throw new ValuationInputError(
      'valuation requires the exact fit peer set; supplied peers do not match model.fitSlugs',
    );
  }
  return fitSlugs;
}

function assertValuationCalibration(calibration: IntervalCalibration): void {
  if (
    !isFiniteNumber(calibration.level) ||
    calibration.level <= 0 ||
    calibration.level >= 1 ||
    !isFiniteNumber(calibration.lowerLogOffset) ||
    !isFiniteNumber(calibration.upperLogOffset) ||
    calibration.lowerLogOffset > calibration.upperLogOffset
  ) {
    throw new ValuationInputError('valuation calibration is malformed');
  }
}

function tokenStatusFor(target: ValuationTarget): ValuationTokenStatus {
  if (target.alreadyTokenized === true) return 'already-tokenized';
  if (target.watchlist === true) return 'watchlist-unconfirmed';
  return 'candidate';
}

function actualMarketCapFor(target: ValuationTarget): number | null {
  return typeof target.actualMarketCapUsd === 'number' &&
    Number.isFinite(target.actualMarketCapUsd) &&
    target.actualMarketCapUsd > 0
    ? target.actualMarketCapUsd
    : null;
}

function buildValuation(
  target: ValuationTarget,
  model: FittedValuationModel,
  peers: readonly ValuationPeer[],
  calibration: IntervalCalibration,
  options: ValuationOptions,
): TokenValuation {
  const logTvl = assertPositiveTargetTvl(target);
  const logPoint = predictLogMarketCap(model, target, options);
  const lowLog = Math.min(
    logPoint + calibration.lowerLogOffset,
    logPoint,
  );
  const highLog = Math.max(
    logPoint + calibration.upperLogOffset,
    logPoint,
  );
  const widthLog = highLog - lowLog;
  const pointUsd = roundUsd(Math.exp(logPoint));
  const lowUsd = Math.min(pointUsd, roundUsd(Math.exp(lowLog)));
  const highUsd = Math.max(pointUsd, roundUsd(Math.exp(highLog)));

  const category = findCategoryStat(model, target.category);
  const peerCategoryN = category?.n ?? 0;
  const peerExamples = peers
    .filter((peerValue) => peerValue.slug !== target.slug)
    .map((peerValue) => {
      const peerLogTvl = Math.log(peerValue.tvlUsd);
      const sameCategory =
        (peerValue.category ?? null) === (target.category ?? null);
      return {
        peer: peerValue,
        sameCategory,
        logTvlDistance: Math.abs(peerLogTvl - logTvl),
      };
    })
    .sort((left, right) => {
      if (left.sameCategory !== right.sameCategory) {
        return left.sameCategory ? -1 : 1;
      }
      if (left.logTvlDistance !== right.logTvlDistance) {
        return left.logTvlDistance - right.logTvlDistance;
      }
      return compareSlugs(left.peer.slug, right.peer.slug);
    })
    .slice(0, options.maxPeerExamples)
    .map((entry): PeerExample =>
      Object.freeze({
        slug: entry.peer.slug,
        category: entry.peer.category,
        tvlUsd: entry.peer.tvlUsd,
        marketCapUsd: entry.peer.marketCapUsd,
        marketCapToTvlRatio: entry.peer.marketCapUsd / entry.peer.tvlUsd,
        sameCategory: entry.sameCategory,
        logTvlDistance: entry.logTvlDistance,
      }),
    );

  return Object.freeze({
    slug: target.slug,
    category: target.category,
    tvlUsd: target.tvlUsd,
    source: target.watchlist === true ? 'watchlist' : 'candidate',
    tokenStatus: tokenStatusFor(target),
    actualMarketCapUsd: actualMarketCapFor(target),
    pointBasis: 'market-cap',
    impliedMarketCapUsd: pointUsd,
    impliedLogMarketCap: logPoint,
    interval: Object.freeze({
      level: calibration.level,
      lowUsd,
      highUsd,
      lowLog,
      highLog,
      widthLog,
    }),
    peerCategoryN,
    peerPoolN: model.fitSampleN,
    peerExamples: Object.freeze(peerExamples),
    modelId: model.spec.id,
    evidenceFlags: evidenceFlagsFor(
      target,
      model,
      calibration,
      logTvl,
      widthLog,
      options,
    ),
  });
}

/**
 * Produce one implied market-cap benchmark with an empirical interval and
 * stable nearest-peer evidence. The public evidence pool must be exactly the
 * model's frozen fit set, and the target must not be one of those fit peers.
 */
export function valueToken(
  target: ValuationTarget,
  model: FittedValuationModel,
  peers: readonly ValuationPeer[],
  calibration: IntervalCalibration,
  inputOptions: Partial<ValuationOptions> = {},
): TokenValuation {
  const options = resolveValuationOptions(inputOptions);
  assertValuationCalibration(calibration);
  const fitSlugs = validateEvidencePeerSet(model, peers);
  if (fitSlugs.has(target.slug)) {
    throw new ValuationInputError(
      `${target.slug} is in the fit set; public valueToken cannot score fitted peers`,
    );
  }
  return buildValuation(target, model, peers, calibration, options);
}

function targetFromCandidate(
  row: SnapshotReport['candidates'][number],
  asOfDay: number,
): ValuationTarget {
  const token = row.token;
  let ageDays: number | null = null;
  if (typeof token.listedAt === 'string' && token.listedAt.trim().length > 0) {
    const listedDay = utcDayNumber(token.listedAt);
    if (listedDay > asOfDay) {
      throw new ValuationInputError(
        `${row.slug}.listedAt is after the snapshot asOf date`,
      );
    }
    ageDays = asOfDay - listedDay;
  }

  return Object.freeze({
    slug: row.slug,
    category:
      typeof token.category === 'string' && token.category.length > 0
        ? token.category
        : null,
    tvlUsd:
      typeof token.tvlUsd === 'number' && Number.isFinite(token.tvlUsd)
        ? token.tvlUsd
        : Number.NaN,
    change7d:
      typeof token.change7d === 'number' && Number.isFinite(token.change7d)
        ? token.change7d
        : null,
    ageDays,
    watchlist: token.watchlist === true,
    alreadyTokenized: row.flags.includes('already-tokenized'),
    actualMarketCapUsd:
      typeof token.marketCapUsd === 'number' &&
      Number.isFinite(token.marketCapUsd) &&
      token.marketCapUsd > 0
        ? token.marketCapUsd
        : null,
  });
}

/**
 * Value every candidate in the snapshot, including watchlist rows and
 * tokenless protocols. Ordering is exact slug codepoint order. Peer-set
 * validation happens once per batch, not once per target.
 */
export function valueCandidates(
  report: SnapshotReport,
  model: FittedValuationModel,
  peers: readonly ValuationPeer[],
  calibration: IntervalCalibration,
  inputOptions: Partial<ValuationOptions> = {},
): readonly TokenValuation[] {
  const options = resolveValuationOptions(inputOptions);
  assertValuationCalibration(calibration);
  const fitSlugs = validateEvidencePeerSet(model, peers);
  const asOfDay = utcDayNumber(report.asOf);
  const valuations = report.candidates.map((row) => {
    const target = targetFromCandidate(row, asOfDay);
    if (fitSlugs.has(target.slug)) {
      throw new ValuationInputError(
        `${target.slug} is in the fit set; candidates must be out-of-fit`,
      );
    }
    return buildValuation(target, model, peers, calibration, options);
  });

  return Object.freeze(
    valuations.sort((left, right) => compareSlugs(left.slug, right.slug)),
  );
}
