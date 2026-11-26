/**
 * Validated adapter for the frozen Token Radar DefiLlama snapshot.
 *
 * The snapshot is read as inert JSON. This module owns the boundary between
 * that untrusted document and the provisional partition core in
 * `lib/universe.ts`:
 *
 * 1. `parseSnapshot` rejects any document that does not carry exactly the
 *    documented fields, types, dates and live watchlist references. Slugs are
 *    preserved byte-for-byte; nothing is trimmed, lowercased or repaired.
 * 2. `adaptSnapshot` maps the accepted document to `NormalizedToken` and runs
 *    the core classifier. The core reason for every row is retained.
 * 3. A narrow, snapshot-only overlay then applies the exclusion rules that are
 *    visible in the file to non-watchlist candidates: versioned names,
 *    wrapped/staked names, the bridge/staking/CEX categories, and exchange-
 *    branded names. `parentProtocol` is deliberately not modelled: it is not
 *    one of the ten documented fields, so a non-watchlist tokenless protocol is
 *    never excluded merely because a parent is suspected.
 *
 * The watchlist is authoritative. A watchlisted protocol remains a candidate
 * even when its name or category looks like a visible exclusion; the overlay
 * records no exclusion for it.
 *
 * Loops are bounded by the input array or the fixed rule tables. There is no
 * retained mutable state, platform-specific API or third-party dependency.
 */

import { classify } from './universe.ts';
import type {
  LedgerRow,
  LedgerStatus,
  NormalizedToken,
} from './universe.ts';

export interface SnapshotHeader {
  readonly asOf: string;
  readonly source: string;
  readonly floorUsd: number;
}

export interface ParsedSnapshot extends SnapshotHeader {
  readonly tokens: readonly NormalizedToken[];
}

export type SnapshotExclusionReason =
  | 'versioned-name'
  | 'wrapped-or-staked-name'
  | 'bridged-category'
  | 'liquid-staking-category'
  | 'liquid-restaking-category'
  | 'restaked-btc-category'
  | 'cex-category'
  | 'exchange-branded-name';

/**
 * A core ledger row plus the snapshot-only exclusion evidence. `reason` and
 * `flags` remain the core classification of the token; `exclusions` explains
 * why a core candidate was moved to `excluded` by this adapter. `status` is the
 * effective status used by the partitions.
 */
export interface SnapshotLedgerRow extends LedgerRow {
  readonly exclusions: readonly SnapshotExclusionReason[];
}

export interface SnapshotReport extends SnapshotHeader {
  readonly ledger: readonly SnapshotLedgerRow[];
  readonly candidates: readonly SnapshotLedgerRow[];
  readonly peers: readonly SnapshotLedgerRow[];
  readonly excluded: readonly SnapshotLedgerRow[];
}

export class SnapshotSchemaError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'SnapshotSchemaError';
    this.path = path;
  }
}

const TOP_LEVEL_KEYS = [
  'as_of',
  'floor_usd',
  'protocols',
  'source',
  'watchlist',
] as const;

const PROTOCOL_KEYS = [
  'category',
  'chains',
  'change_7d',
  'gecko_id',
  'listed_at',
  'mcap_usd',
  'name',
  'slug',
  'symbol',
  'tvl_usd',
] as const;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SOURCE_PATTERN =
  /^DefiLlama https:\/\/api\.llama\.fi\/protocols, fetched (\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

function fail(path: string, message: string): never {
  throw new SnapshotSchemaError(path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(`${path}.${key}`, 'missing documented field');
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(`${path}.${key}`, 'unexpected field');
    }
  }
}

function assertDateParts(
  yearText: string,
  monthText: string,
  dayText: string,
  path: string,
): void {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    fail(path, 'expected a real calendar date in YYYY-MM-DD form');
  }
}

function assertDate(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    fail(path, 'expected a YYYY-MM-DD string');
  }
  const match = DATE_PATTERN.exec(value);
  if (match === null) {
    fail(path, 'expected a YYYY-MM-DD string');
  }
  assertDateParts(match[1] as string, match[2] as string, match[3] as string, path);
  return value;
}

function assertSource(value: unknown, asOf: string, path: string): string {
  if (typeof value !== 'string') {
    fail(
      path,
      'expected "DefiLlama https://api.llama.fi/protocols, fetched <ISO UTC datetime>"',
    );
  }
  const match = SOURCE_PATTERN.exec(value);
  if (match === null) {
    fail(
      path,
      'expected "DefiLlama https://api.llama.fi/protocols, fetched <ISO UTC datetime>"',
    );
  }

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const stamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  const valid =
    stamp.getUTCFullYear() === year &&
    stamp.getUTCMonth() === month - 1 &&
    stamp.getUTCDate() === day &&
    stamp.getUTCHours() === hour &&
    stamp.getUTCMinutes() === minute &&
    stamp.getUTCSeconds() === second;

  if (!valid) {
    fail(path, 'fetched timestamp is not a real UTC datetime');
  }
  if (`${yearText}-${monthText}-${dayText}` !== asOf) {
    fail(path, 'fetched date does not match as_of');
  }
  return value;
}

function assertString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    fail(path, 'expected a string');
  }
  return value;
}

function assertNullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return assertString(value, path);
}

function assertSlug(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value !== value.trim()
  ) {
    fail(path, 'expected an exact, non-blank slug without outer whitespace');
  }
  return value;
}

function assertWholeUsd(value: unknown, path: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value)
  ) {
    fail(path, 'expected a finite safe whole-dollar integer');
  }
  return value;
}

function assertFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, 'expected a finite number');
  }
  return value;
}

function assertNullableFiniteNumber(value: unknown, path: string): number | null {
  if (value === null) return null;
  return assertFiniteNumber(value, path);
}

function assertChains(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    fail(path, 'expected an array of chain names');
  }
  return Object.freeze(
    value.map((chain, index) => {
      if (typeof chain !== 'string') {
        fail(`${path}[${index}]`, 'expected a chain name string');
      }
      return chain;
    }),
  );
}

function readProtocol(value: unknown, index: number): NormalizedToken {
  const path = `snapshot.protocols[${index}]`;
  if (!isRecord(value)) {
    fail(path, 'expected a protocol object');
  }
  assertExactKeys(value, PROTOCOL_KEYS, path);

  const slug = assertSlug(value.slug, `${path}.slug`);
  const name = assertString(value.name, `${path}.name`);
  const category = assertNullableString(value.category, `${path}.category`);
  const chains = assertChains(value.chains, `${path}.chains`);
  const tvlUsd = assertWholeUsd(value.tvl_usd, `${path}.tvl_usd`);
  if (tvlUsd < 0) {
    fail(`${path}.tvl_usd`, 'expected a non-negative whole-dollar amount');
  }
  const change7d = assertNullableFiniteNumber(
    value.change_7d,
    `${path}.change_7d`,
  );
  const marketCapUsd =
    value.mcap_usd === null
      ? null
      : assertWholeUsd(value.mcap_usd, `${path}.mcap_usd`);
  const listedAt =
    value.listed_at === null
      ? null
      : assertDate(value.listed_at, `${path}.listed_at`);
  const geckoId = assertNullableString(value.gecko_id, `${path}.gecko_id`);
  const symbol = assertNullableString(value.symbol, `${path}.symbol`);

  return {
    slug,
    name,
    category,
    chains,
    tvlUsd,
    change7d,
    marketCapUsd,
    listedAt,
    geckoId,
    symbol,
  };
}

/**
 * Validate an unknown parsed JSON value against the documented snapshot
 * schema. The returned tokens are the exact documented slugs and nullable
 * values, with only the watchlist boolean derived from the watchlist refs.
 */
export function parseSnapshot(input: unknown): ParsedSnapshot {
  if (!isRecord(input)) {
    fail('snapshot', 'expected a JSON object');
  }
  assertExactKeys(input, TOP_LEVEL_KEYS, 'snapshot');

  const asOf = assertDate(input.as_of, 'snapshot.as_of');
  const source = assertSource(input.source, asOf, 'snapshot.source');

  const floorUsd = assertWholeUsd(input.floor_usd, 'snapshot.floor_usd');
  if (floorUsd <= 0) {
    fail('snapshot.floor_usd', 'expected a positive whole-dollar floor');
  }

  if (!Array.isArray(input.protocols)) {
    fail('snapshot.protocols', 'expected an array of protocol objects');
  }
  if (!Array.isArray(input.watchlist)) {
    fail('snapshot.watchlist', 'expected an array of slug strings');
  }

  const baseTokens = Array.from(input.protocols, (protocol, index) =>
    readProtocol(protocol, index),
  );

  const slugs = new Set<string>();
  baseTokens.forEach((token, index) => {
    if (slugs.has(token.slug)) {
      fail(
        `snapshot.protocols[${index}].slug`,
        `duplicate protocol slug "${token.slug}"`,
      );
    }
    slugs.add(token.slug);
  });

  const watchlistSlugs = new Set<string>();
  Array.from(input.watchlist).forEach((value, index) => {
    const path = `snapshot.watchlist[${index}]`;
    const slug = assertSlug(value, path);
    if (watchlistSlugs.has(slug)) {
      fail(path, `duplicate watchlist slug "${slug}"`);
    }
    if (!slugs.has(slug)) {
      fail(path, `watchlist slug "${slug}" does not name a protocol`);
    }
    watchlistSlugs.add(slug);
  });

  const tokens = Object.freeze(
    baseTokens.map((token) =>
      Object.freeze({
        ...token,
        watchlist: watchlistSlugs.has(token.slug),
      }),
    ),
  );

  return Object.freeze({ asOf, source, floorUsd, tokens });
}

const CATEGORY_EXCLUSIONS: Readonly<Record<string, SnapshotExclusionReason>> =
  Object.freeze({
    Bridge: 'bridged-category',
    'Canonical Bridge': 'bridged-category',
    'Liquid Staking': 'liquid-staking-category',
    'Liquid Restaking': 'liquid-restaking-category',
    'Restaked BTC': 'restaked-btc-category',
    CEX: 'cex-category',
  });

const EXCHANGE_NAMES = [
  'Binance',
  'Coinbase',
  'Bybit',
  'Kraken',
  'Bitget',
  'OKX',
  'Bitfinex',
  'Gemini',
] as const;

// The watchlist definition's pattern, applied exactly as documented: a version
// marker is a separate suffix token such as "V2", "v2.0" or "2.0".
const VERSION_SUFFIX = /\s(?:V\d+(?:\.\d+)?|v\d+(?:\.\d+)?|\d+\.\d+)$/;
const WRAPPED_OR_STAKED_WORD = /\b(?:wrapped|staked|staking)\b/i;

const NO_EXCLUSIONS: readonly SnapshotExclusionReason[] = Object.freeze([]);

/**
 * Evidence visible in the ten documented fields. `parentProtocol` is absent
 * from the snapshot by design and therefore cannot appear here.
 */
function visibleExclusions(
  token: NormalizedToken,
): readonly SnapshotExclusionReason[] {
  const reasons: SnapshotExclusionReason[] = [];
  const name = typeof token.name === 'string' ? token.name : '';

  if (VERSION_SUFFIX.test(name)) {
    reasons.push('versioned-name');
  }
  if (WRAPPED_OR_STAKED_WORD.test(name)) {
    reasons.push('wrapped-or-staked-name');
  }

  if (typeof token.category === 'string') {
    const categoryReason = CATEGORY_EXCLUSIONS[token.category];
    if (categoryReason !== undefined) {
      reasons.push(categoryReason);
    }
  }

  const lowerName = name.toLowerCase();
  if (
    EXCHANGE_NAMES.some((exchange) =>
      lowerName.startsWith(exchange.toLowerCase()),
    )
  ) {
    reasons.push('exchange-branded-name');
  }

  return Object.freeze(reasons);
}

function overlayRow(row: LedgerRow): SnapshotLedgerRow {
  const exclusions =
    row.status === 'candidate' && row.token.watchlist !== true
      ? visibleExclusions(row.token)
      : NO_EXCLUSIONS;
  const status: LedgerStatus =
    exclusions.length > 0 ? 'excluded' : row.status;

  return Object.freeze({
    slug: row.slug,
    status,
    reason: row.reason,
    flags: row.flags,
    token: row.token,
    exclusions,
  });
}

/**
 * Validate and adapt the snapshot, then return the header plus a fully
 * reconciled ledger. `candidates + peers + excluded === ledger`; each slug is
 * present exactly once.
 */
export function adaptSnapshot(input: unknown): SnapshotReport {
  const parsed = parseSnapshot(input);
  const classification = classify({ tokens: parsed.tokens });
  const ledger = Object.freeze(classification.ledger.map(overlayRow));

  return Object.freeze({
    asOf: parsed.asOf,
    source: parsed.source,
    floorUsd: parsed.floorUsd,
    ledger,
    candidates: Object.freeze(
      ledger.filter((row) => row.status === 'candidate'),
    ),
    peers: Object.freeze(ledger.filter((row) => row.status === 'peer')),
    excluded: Object.freeze(ledger.filter((row) => row.status === 'excluded')),
  });
}
