/**
 * Deterministic assembly of the official Token Radar output contract.
 *
 * This module is pure: it takes a validated `SnapshotReport`, a completed
 * `ValuationBenchmark` and a typed farm planner, and returns the single data
 * document that powers both `/output/data.js` and `/output/board.json`. It
 * performs no filesystem, environment, network or module work, so it runs
 * standalone in tests and never imports the pending `lib/farm.ts` branch.
 *
 * Public-field discipline:
 * - rows come from `benchmark.valuations` (all `report.candidates`) joined to
 *   the authoritative snapshot ledger;
 * - only display fields are copied; the raw benchmark object, model ids,
 *   holdout records, split slug lists and peer evidence internals stay out;
 * - peers keep only `{slug, tvlUsd, marketCapUsd}`;
 * - `flags` is the compact `TokenValuation.evidenceFlags` list.
 *
 * Token status compatibility: the isolated base predates
 * `TokenValuation.tokenStatus`. The valuation value is used when present (the
 * integrated branch); otherwise it is derived from the ledger exactly as the
 * fixed valuation does: `already-tokenized` when the row carries that flag,
 * `watchlist-unconfirmed` for any other watchlist row, and `candidate`
 * otherwise. This fallback is deliberately documented here so the old-base
 * output stays truthful without inventing token evidence.
 *
 * Ranking: implied values are rounded to whole dollars and clamped to the
 * official $1..$100,000,000,000,000 range. Rows sort by implied value
 * descending, ties by exact slug ascending (code-unit order), then receive
 * ranks 1..N. Slugs are never trimmed, lowercased or otherwise normalized.
 */

import type { SnapshotLedgerRow, SnapshotReport } from './snapshot.ts';
import type { ValuationBenchmark } from './evaluation.ts';
import type { TokenValuation } from './valuation.ts';

/** Official board ceiling: $100T in whole dollars. */
export const MAX_IMPLIED_USD = 100_000_000_000_000;
/** Official board gate: 100 to 4,000 rows. */
export const BOARD_MIN_ROWS = 100;
export const BOARD_MAX_ROWS = 4_000;
/** Official board byte cap. */
export const BOARD_MAX_BYTES = 8 * 1024 * 1024;

export type FarmPlanStatus =
  | 'source-backed'
  | 'verify-terms'
  | 'research-only';

/** Structural copy of the pending `lib/farm.ts` plan contract. */
export interface FarmPlan {
  readonly status: FarmPlanStatus;
  readonly steps: readonly string[];
  readonly sources: readonly string[];
}

/** The typed farm boundary: `buildFarmPlan` in production, a stub in tests. */
export type FarmPlanner = (row: SnapshotLedgerRow) => FarmPlan;

/**
 * `already-tokenized` and `watchlist-unconfirmed` are carried from valuation
 * when available; on the old base they are reconstructed from ledger evidence.
 */
export type TokenStatus =
  | 'already-tokenized'
  | 'watchlist-unconfirmed'
  | 'candidate';

export interface EntryPeer {
  readonly slug: string;
  readonly tvlUsd: number;
  readonly marketCapUsd: number;
}

export interface EntryFarm {
  readonly status: FarmPlanStatus;
  readonly steps: readonly string[];
  readonly sources: readonly string[];
}

export interface EntryRow {
  readonly slug: string;
  readonly name: string;
  readonly rank: number;
  readonly category: string | null;
  readonly chains: readonly string[];
  readonly tvlUsd: number;
  readonly change7d: number | null;
  readonly listedAt: string | null;
  readonly watchlist: boolean;
  readonly impliedValueUsd: number;
  readonly lowUsd: number;
  readonly highUsd: number;
  readonly peerCount: number;
  readonly peers: readonly EntryPeer[];
  readonly flags: readonly string[];
  readonly tokenStatus: TokenStatus;
  readonly farm: EntryFarm;
}

export interface EntryCounts {
  readonly protocols: number;
  readonly candidates: number;
  readonly watchlist: number;
  readonly peers: number;
  readonly excluded: number;
}

export interface EntryBenchmarkMetric {
  readonly medianAbsLogError: number;
  readonly coverage: number;
  readonly medianAbsolutePercentageError: number;
  /** Positive means the realized market cap sits above the prediction. */
  readonly medianSignedLogError?: number;
}

export interface EntryBenchmark {
  readonly sampleN: number;
  readonly selected: EntryBenchmarkMetric;
  readonly global: EntryBenchmarkMetric;
  readonly category: EntryBenchmarkMetric;
  readonly intervalLevel: number;
  readonly label: string;
}

/** The exact `globalThis.TOKEN_RADAR_DATA` contract. */
export interface EntryData {
  readonly asOf: string;
  readonly source: string;
  readonly counts: EntryCounts;
  readonly benchmark: EntryBenchmark;
  readonly rows: readonly EntryRow[];
}

/** One row of the official `board.json`. */
export interface BoardRow {
  readonly slug: string;
  readonly name: string;
  readonly rank: number;
  readonly implied_value_usd: number;
  readonly farm_steps: readonly string[];
}

export class EntryContractError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'EntryContractError';
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new EntryContractError(path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function compareSlugs(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Median by linear interpolation, matching `quantileSorted(..., 0.5)`. */
function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) return sorted[0] as number;
  const position = (sorted.length - 1) * 0.5;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] as number;
  const upperValue = sorted[upper] as number;
  if (lower === upper) return lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function sourceWholeUsd(value: unknown, path: string): number {
  if (
    !isFiniteNumber(value) ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    fail(path, 'expected a positive safe whole-dollar amount');
  }
  return value;
}

function wholeUsd(value: unknown, path: string): number {
  if (!isFiniteNumber(value)) {
    fail(path, 'expected a finite USD amount');
  }
  const rounded = Math.round(value);
  if (!Number.isSafeInteger(rounded)) {
    fail(path, 'expected a safe whole-dollar amount');
  }
  return Math.min(MAX_IMPLIED_USD, Math.max(1, rounded));
}

function safeIntegerAtLeast(
  value: unknown,
  path: string,
  minimum: number,
): number {
  if (
    !isFiniteNumber(value) ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    fail(path, `expected a safe integer >= ${minimum}`);
  }
  return value;
}

function textAtLeastOne(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(path, 'expected a non-blank string');
  }
  return value;
}

function readMetric(
  evaluation: unknown,
  path: string,
): EntryBenchmarkMetric {
  if (!isRecord(evaluation)) {
    fail(path, 'expected a benchmark model evaluation object');
  }

  const metric: {
    medianAbsLogError: number;
    coverage: number;
    medianAbsolutePercentageError: number;
    medianSignedLogError?: number;
  } = {
    medianAbsLogError: safeNonNegative(
      evaluation.medianAbsLogError,
      `${path}.medianAbsLogError`,
    ),
    coverage: unitInterval(evaluation.coverage, `${path}.coverage`),
    medianAbsolutePercentageError: safeNonNegative(
      evaluation.medianAbsolutePercentageError,
      `${path}.medianAbsolutePercentageError`,
    ),
  };

  let signed: number | undefined;
  if (isFiniteNumber(evaluation.medianSignedLogError)) {
    signed = evaluation.medianSignedLogError;
  } else if (Array.isArray(evaluation.records) && evaluation.records.length > 0) {
    const residuals = evaluation.records.map((record, index) => {
      if (!isRecord(record) || !isFiniteNumber(record.residualLog)) {
        fail(`${path}.records[${index}].residualLog`, 'expected a finite number');
      }
      return record.residualLog;
    });
    signed = median(residuals);
  }
  if (signed !== undefined) {
    metric.medianSignedLogError = signed;
  }

  return Object.freeze(metric);
}

function safeNonNegative(value: unknown, path: string): number {
  if (!isFiniteNumber(value) || value < 0) {
    fail(path, 'expected a finite number >= 0');
  }
  return value;
}

function unitInterval(value: unknown, path: string): number {
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    fail(path, 'expected a finite number in [0, 1]');
  }
  return value;
}

function benchmarkFor(
  report: SnapshotReport,
  benchmark: ValuationBenchmark,
): EntryBenchmark {
  if (!isRecord(benchmark)) {
    fail('benchmark', 'expected a valuation benchmark object');
  }
  if (benchmark.asOf !== report.asOf) {
    fail(
      'benchmark.asOf',
      `expected the snapshot date ${report.asOf}, received ${String(benchmark.asOf)}`,
    );
  }

  const holdout = benchmark.holdout as unknown;
  if (!isRecord(holdout)) {
    fail('benchmark.holdout', 'expected a holdout comparison object');
  }
  const calibration = benchmark.calibrationPool as unknown;
  if (!isRecord(calibration)) {
    fail('benchmark.calibrationPool', 'expected a calibration pool object');
  }
  const level = unitInterval(
    calibration.level,
    'benchmark.calibrationPool.level',
  );

  return Object.freeze({
    sampleN: safeIntegerAtLeast(holdout.sampleN, 'benchmark.holdout.sampleN', 1),
    selected: readMetric(holdout.selected, 'benchmark.holdout.selected'),
    global: readMetric(holdout.baseline, 'benchmark.holdout.baseline'),
    category: readMetric(
      holdout.categoryBaseline,
      'benchmark.holdout.categoryBaseline',
    ),
    intervalLevel: level,
    label:
      `Held-out peer comparison at the ${Math.round(level * 100)}% empirical ` +
      'interval; a positive median signed log error means the realized market ' +
      'cap sits above the implied value.',
  });
}

function tokenStatusFor(
  row: SnapshotLedgerRow,
  valuation: TokenValuation,
): TokenStatus {
  const carried = (valuation as unknown as { tokenStatus?: unknown }).tokenStatus;
  if (
    carried === 'already-tokenized' ||
    carried === 'watchlist-unconfirmed' ||
    carried === 'candidate'
  ) {
    return carried;
  }
  if (row.flags.includes('already-tokenized')) return 'already-tokenized';
  if (row.token.watchlist === true) return 'watchlist-unconfirmed';
  return 'candidate';
}

function farmFor(row: SnapshotLedgerRow, farm: FarmPlanner): EntryFarm {
  let raw: FarmPlan;
  try {
    raw = farm(row);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`rows.${row.slug}.farm`, `farm planner failed: ${detail}`);
  }
  if (!isRecord(raw)) {
    fail(`rows.${row.slug}.farm`, 'expected a farm plan object');
  }
  if (
    raw.status !== 'source-backed' &&
    raw.status !== 'verify-terms' &&
    raw.status !== 'research-only'
  ) {
    fail(`rows.${row.slug}.farm.status`, 'expected a known farm plan status');
  }
  if (!Array.isArray(raw.steps)) {
    fail(`rows.${row.slug}.farm.steps`, 'expected an array of step strings');
  }
  if (raw.steps.length < 3 || raw.steps.length > 12) {
    fail(
      `rows.${row.slug}.farm.steps`,
      `expected 3 to 12 steps, received ${raw.steps.length}`,
    );
  }
  const steps = raw.steps.map((step, index) => {
    if (typeof step !== 'string') {
      fail(`rows.${row.slug}.farm.steps[${index}]`, 'expected a string');
    }
    const length = step.trim().length;
    if (length < 20 || length > 600) {
      fail(
        `rows.${row.slug}.farm.steps[${index}]`,
        `expected 20 to 600 trimmed characters, received ${length}`,
      );
    }
    return step;
  });
  if (!Array.isArray(raw.sources)) {
    fail(`rows.${row.slug}.farm.sources`, 'expected an array of source strings');
  }
  const sources = raw.sources.map((source, index) => {
    if (typeof source !== 'string' || source.trim().length === 0) {
      fail(
        `rows.${row.slug}.farm.sources[${index}]`,
        'expected a non-blank string',
      );
    }
    return source;
  });

  return Object.freeze({
    status: raw.status,
    steps: Object.freeze(steps),
    sources: Object.freeze(sources),
  });
}

interface RowDraft {
  readonly slug: string;
  readonly name: string;
  readonly category: string | null;
  readonly chains: readonly string[];
  readonly tvlUsd: number;
  readonly change7d: number | null;
  readonly listedAt: string | null;
  readonly watchlist: boolean;
  readonly impliedValueUsd: number;
  readonly lowUsd: number;
  readonly highUsd: number;
  readonly peerCount: number;
  readonly peers: readonly EntryPeer[];
  readonly flags: readonly string[];
  readonly tokenStatus: TokenStatus;
  readonly farm: EntryFarm;
}

function peerFor(example: unknown, path: string): EntryPeer {
  if (!isRecord(example)) {
    fail(path, 'expected a peer example object');
  }
  const slug = textAtLeastOne(example.slug, `${path}.slug`);
  if (/\s/.test(slug)) {
    fail(`${path}.slug`, 'expected a slug with no whitespace');
  }
  return Object.freeze({
    slug,
    tvlUsd: sourceWholeUsd(example.tvlUsd, `${path}.tvlUsd`),
    marketCapUsd: sourceWholeUsd(
      example.marketCapUsd,
      `${path}.marketCapUsd`,
    ),
  });
}

function rowDraft(
  row: SnapshotLedgerRow,
  valuation: TokenValuation,
  farm: FarmPlanner,
): RowDraft {
  const token = row.token;
  const name = textAtLeastOne(token.name, `rows.${row.slug}.name`);
  const category =
    token.category === null || token.category === undefined
      ? null
      : textAtLeastOne(token.category, `rows.${row.slug}.category`);
  if (!Array.isArray(token.chains)) {
    fail(`rows.${row.slug}.chains`, 'expected an array of chain names');
  }
  const chains = token.chains.map((chain, index) => {
    if (typeof chain !== 'string') {
      fail(`rows.${row.slug}.chains[${index}]`, 'expected a chain name string');
    }
    return chain;
  });
  const tvlUsd = sourceWholeUsd(token.tvlUsd, `rows.${row.slug}.tvlUsd`);
  const change7d =
    token.change7d === null || token.change7d === undefined
      ? null
      : isFiniteNumber(token.change7d)
        ? token.change7d
        : fail(`rows.${row.slug}.change7d`, 'expected a finite number or null');
  const listedAt =
    token.listedAt === null || token.listedAt === undefined
      ? null
      : textAtLeastOne(token.listedAt, `rows.${row.slug}.listedAt`);

  const impliedValueUsd = wholeUsd(
    valuation.impliedMarketCapUsd,
    `rows.${row.slug}.impliedValueUsd`,
  );
  const interval = valuation.interval as unknown;
  if (!isRecord(interval)) {
    fail(`rows.${row.slug}.lowUsd`, 'expected an interval object');
  }
  const lowUsd = Math.min(
    wholeUsd(interval.lowUsd, `rows.${row.slug}.lowUsd`),
    impliedValueUsd,
  );
  const highUsd = Math.max(
    wholeUsd(interval.highUsd, `rows.${row.slug}.highUsd`),
    impliedValueUsd,
  );

  if (!Array.isArray(valuation.peerExamples)) {
    fail(`rows.${row.slug}.peers`, 'expected an array of peer examples');
  }
  const peers = valuation.peerExamples.map((example, index) =>
    peerFor(example, `rows.${row.slug}.peers[${index}]`),
  );
  const peerCount = safeIntegerAtLeast(
    valuation.peerPoolN,
    `rows.${row.slug}.peerCount`,
    peers.length,
  );

  if (!Array.isArray(valuation.evidenceFlags)) {
    fail(`rows.${row.slug}.flags`, 'expected an array of evidence flags');
  }
  const flags = valuation.evidenceFlags.map((flag, index) => {
    if (typeof flag !== 'string') {
      fail(`rows.${row.slug}.flags[${index}]`, 'expected a flag string');
    }
    return flag;
  });

  return {
    slug: row.slug,
    name,
    category,
    chains: Object.freeze(chains),
    tvlUsd,
    change7d,
    listedAt,
    watchlist: token.watchlist === true,
    impliedValueUsd,
    lowUsd,
    highUsd,
    peerCount,
    peers: Object.freeze(peers),
    flags: Object.freeze(flags),
    tokenStatus: tokenStatusFor(row, valuation),
    farm: farmFor(row, farm),
  };
}

function toEntryRow(draft: RowDraft, rank: number): EntryRow {
  return Object.freeze({
    slug: draft.slug,
    name: draft.name,
    rank,
    category: draft.category,
    chains: draft.chains,
    tvlUsd: draft.tvlUsd,
    change7d: draft.change7d,
    listedAt: draft.listedAt,
    watchlist: draft.watchlist,
    impliedValueUsd: draft.impliedValueUsd,
    lowUsd: draft.lowUsd,
    highUsd: draft.highUsd,
    peerCount: draft.peerCount,
    peers: draft.peers,
    flags: draft.flags,
    tokenStatus: draft.tokenStatus,
    farm: draft.farm,
  });
}

/**
 * Assemble the UI data document. Every candidate must have exactly one
 * valuation, every valuation must name a candidate, every watchlist slug from
 * the authoritative ledger must survive into the rows, and the valuation
 * counts must reconcile with the snapshot partition.
 */
export function assemble(
  report: SnapshotReport,
  benchmark: ValuationBenchmark,
  farm: FarmPlanner,
): EntryData {
  if (typeof farm !== 'function') {
    throw new TypeError('assemble: farm must be a function');
  }
  if (!Array.isArray(benchmark.valuations)) {
    fail('benchmark.valuations', 'expected an array of valuations');
  }

  const candidateBySlug = new Map<string, SnapshotLedgerRow>();
  for (const row of report.candidates) {
    if (candidateBySlug.has(row.slug)) {
      fail('report.candidates', `duplicate candidate slug "${row.slug}"`);
    }
    candidateBySlug.set(row.slug, row);
  }

  const seen = new Set<string>();
  const drafts: RowDraft[] = benchmark.valuations.map((valuation, index) => {
    const path = `benchmark.valuations[${index}]`;
    if (!isRecord(valuation) || typeof valuation.slug !== 'string') {
      fail(path, 'expected a valuation with a slug');
    }
    if (seen.has(valuation.slug)) {
      fail(`${path}.slug`, `duplicate valuation slug "${valuation.slug}"`);
    }
    seen.add(valuation.slug);
    const row = candidateBySlug.get(valuation.slug);
    if (row === undefined) {
      fail(
        `${path}.slug`,
        `"${valuation.slug}" is not a candidate in the validated snapshot`,
      );
    }
    return rowDraft(row, valuation, farm);
  });

  const missing = [...candidateBySlug.keys()].filter(
    (slug) => !seen.has(slug),
  );
  if (missing.length > 0) {
    fail(
      'benchmark.valuations',
      `no valuation for candidate slug(s): ${missing.join(', ')}`,
    );
  }

  const ranked = [...drafts].sort((left, right) => {
    if (left.impliedValueUsd !== right.impliedValueUsd) {
      return right.impliedValueUsd - left.impliedValueUsd;
    }
    return compareSlugs(left.slug, right.slug);
  });
  const rows = Object.freeze(
    ranked.map((draft, index) => toEntryRow(draft, index + 1)),
  );

  const counts: EntryCounts = Object.freeze({
    protocols: report.ledger.length,
    candidates: report.candidates.length,
    watchlist: report.ledger.filter(
      (row) => row.token.watchlist === true,
    ).length,
    peers: report.peers.length,
    excluded: report.excluded.length,
  });
  if (
    counts.candidates + counts.peers + counts.excluded !==
    counts.protocols
  ) {
    fail(
      'counts',
      'candidates + peers + excluded does not equal the protocol ledger',
    );
  }
  if (rows.length !== counts.candidates) {
    fail(
      'rows',
      `expected ${counts.candidates} candidate rows, received ${rows.length}`,
    );
  }
  if (counts.watchlist < 1) {
    fail('counts.watchlist', 'the snapshot ledger carries no watchlist rows');
  }
  const valued = new Set(rows.map((row) => row.slug));
  const missingWatchlist = report.ledger
    .filter((row) => row.token.watchlist === true)
    .map((row) => row.slug)
    .filter((slug) => !valued.has(slug));
  if (missingWatchlist.length > 0) {
    fail(
      'rows',
      `watchlist coverage is incomplete; missing ${missingWatchlist.join(', ')}`,
    );
  }
  const watchedRows = rows.filter((row) => row.watchlist).length;
  if (watchedRows !== counts.watchlist) {
    fail(
      'counts.watchlist',
      `the watchlist count ${counts.watchlist} does not match ${watchedRows} rows`,
    );
  }

  return Object.freeze({
    asOf: report.asOf,
    source: report.source,
    counts,
    benchmark: benchmarkFor(report, benchmark),
    rows,
  });
}

/**
 * Derive `board.json` rows from the same assembled rows and validate the
 * official board gate locally: 100..4,000 rows, unique snapshot slugs, ranks
 * 1..N, non-increasing whole-dollar implied values, and 3..12 farm steps of
 * 20..600 trimmed characters.
 */
export function buildBoard(
  data: EntryData,
  report: SnapshotReport,
): readonly BoardRow[] {
  if (!Array.isArray(data.rows)) {
    fail('board.rows', 'expected assembled rows');
  }
  if (
    data.rows.length < BOARD_MIN_ROWS ||
    data.rows.length > BOARD_MAX_ROWS
  ) {
    fail(
      'board.rows',
      `expected ${BOARD_MIN_ROWS} to ${BOARD_MAX_ROWS} rows, received ${data.rows.length}`,
    );
  }
  const snapshotSlugs = new Set(report.ledger.map((row) => row.slug));
  const order = [...data.rows].sort((left, right) => left.rank - right.rank);
  const seen = new Set<string>();
  const values: number[] = [];
  const board = order.map((row, index) => {
    if (
      typeof row.slug !== 'string' ||
      row.slug.length < 1 ||
      row.slug.length > 128 ||
      /\s/.test(row.slug)
    ) {
      fail(
        `board.rows[${index}].slug`,
        'expected a 1 to 128 character slug with no whitespace',
      );
    }
    if (typeof row.name !== 'string' || row.name.length === 0) {
      fail(`board.rows[${index}].name`, 'expected a non-empty name');
    }
    if (!snapshotSlugs.has(row.slug)) {
      fail(
        `board.rows[${index}].slug`,
        `"${row.slug}" is not a snapshot protocol`,
      );
    }
    if (seen.has(row.slug)) {
      fail(`board.rows[${index}].slug`, `duplicate slug "${row.slug}"`);
    }
    seen.add(row.slug);
    if (row.rank !== index + 1) {
      fail(
        `board.rows[${index}].rank`,
        `expected rank ${index + 1}, received ${row.rank}`,
      );
    }
    if (!Number.isSafeInteger(row.impliedValueUsd) ||
        row.impliedValueUsd < 1 ||
        row.impliedValueUsd > MAX_IMPLIED_USD) {
      fail(
        `board.rows[${index}].implied_value_usd`,
        'expected a whole dollar amount in the official range',
      );
    }
    if (values.length > 0 && row.impliedValueUsd > (values[values.length - 1] as number)) {
      fail(
        `board.rows[${index}].implied_value_usd`,
        'implied values must not rise as rank ascends',
      );
    }
    values.push(row.impliedValueUsd);
    if (row.farm.steps.length < 3 || row.farm.steps.length > 12) {
      fail(
        `board.rows[${index}].farm_steps`,
        'expected 3 to 12 steps',
      );
    }
    const farm_steps = row.farm.steps.map((step, stepIndex) => {
      if (typeof step !== 'string') {
        fail(
          `board.rows[${index}].farm_steps[${stepIndex}]`,
          'expected a string',
        );
      }
      const length = step.trim().length;
      if (length < 20 || length > 600) {
        fail(
          `board.rows[${index}].farm_steps[${stepIndex}]`,
          `expected 20 to 600 trimmed characters, received ${length}`,
        );
      }
      return step;
    });
    return Object.freeze({
      slug: row.slug,
      name: row.name,
      rank: row.rank,
      implied_value_usd: row.impliedValueUsd,
      farm_steps: Object.freeze(farm_steps),
    });
  });
  if (board.length >= 2 && new Set(values).size === 1) {
    fail(
      'board.rows',
      'every implied value is identical; a board that ranks nothing is refused',
    );
  }
  return Object.freeze(board);
}

function escapeJsPayload(json: string): string {
  const escapes: Readonly<Record<string, string>> = {
    '<': '\\u003c',
    '>': '\\u003e',
    '&': '\\u0026',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029',
  };
  return json.replace(/[<>&\u2028\u2029]/g, (character) => {
    const replacement = escapes[character];
    if (replacement === undefined) {
      throw new Error(`no escape for ${character}`);
    }
    return replacement;
  });
}

/**
 * The classic assignment script the dashboard reads at `../data.js`. The JSON
 * payload is ASCII-safe for inline script contexts: `<`, `>`, `&` and the two
 * JavaScript line separators are escaped without changing parsed values.
 */
export function dataScript(data: EntryData): string {
  const json = JSON.stringify(data, null, 2);
  if (json === undefined) {
    throw new TypeError('dataScript: data has no JSON form');
  }
  return `globalThis.TOKEN_RADAR_DATA = ${escapeJsPayload(json)};\n`;
}
