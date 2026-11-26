/**
 * Token Radar snapshot normalization and classification core.
 *
 * This module deliberately consumes an already-normalized snapshot shape. The
 * real ingest adapter is outside this repository for now; keeping the boundary
 * typed here avoids guessing undocumented upstream fields.
 */

export type CandidateReason =
  | 'watchlist'
  | 'apparent-wrapper'
  | 'versioned-name'
  | 'missing-identity'
  | 'ambiguous-identity'
  | 'missing-market-cap'
  | 'unusable-market-cap';

export type ClassificationReason = CandidateReason | 'peer';

export type LedgerFlag =
  | 'apparent-wrapper'
  | 'versioned-name'
  | 'missing-identity'
  | 'ambiguous-identity'
  | 'missing-market-cap'
  | 'unusable-market-cap'
  | 'missing-listed-at'
  | 'missing-change-7d';

export interface NormalizedToken {
  readonly slug: string;
  readonly name?: string | null;
  readonly symbol?: string | null;
  readonly marketCapUsd?: number | null;
  readonly listedAt?: string | null;
  readonly change7d?: number | null;
  readonly watchlist?: boolean;
}

export interface NormalizedSnapshot {
  readonly tokens: readonly NormalizedToken[];
}

export interface LedgerRow {
  readonly slug: string;
  readonly status: 'peer' | 'candidate';
  readonly reason: ClassificationReason;
  readonly flags: readonly LedgerFlag[];
  readonly token: NormalizedToken;
}

export interface ClassificationResult {
  readonly candidates: readonly LedgerRow[];
  readonly peers: readonly LedgerRow[];
  readonly ledger: readonly LedgerRow[];
}

export class DuplicateSlugError extends Error {
  readonly slugs: readonly string[];

  constructor(slugs: readonly string[]) {
    super(`Duplicate slug(s): ${slugs.join(', ')}`);
    this.name = 'DuplicateSlugError';
    this.slugs = Object.freeze([...slugs]);
  }
}

export class InvalidSlugError extends Error {
  constructor(index: number) {
    super(`Token at index ${index} has a blank slug`);
    this.name = 'InvalidSlugError';
  }
}

function compareSlugs(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeText(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

type MarketState = 'usable' | 'missing' | 'unusable';

function marketState(token: NormalizedToken): MarketState {
  if (token.marketCapUsd == null) return 'missing';
  if (
    typeof token.marketCapUsd !== 'number' ||
    !Number.isFinite(token.marketCapUsd) ||
    token.marketCapUsd <= 0
  ) {
    return 'unusable';
  }
  return 'usable';
}

type IdentityState = 'unequivocal' | 'ambiguous' | 'missing';

// Identity is only unequivocal when both name and symbol survive trimming.
// One missing half is ambiguous; both missing is simply missing. This is a
// conservative data-quality rule, not a chain/contract identity proof.
function identityState(
  name: string | undefined,
  symbol: string | undefined,
): IdentityState {
  if (name === undefined && symbol === undefined) return 'missing';
  if (name === undefined || symbol === undefined) return 'ambiguous';
  return 'unequivocal';
}

// Conservative wrapper signals only: the "Wrapped " name prefix or the
// lowercase-w/uppercase-next ERC-20 symbol convention (wETH, wBTC). An
// uppercase W is not enough evidence on its own (e.g. WIN).
function looksLikeWrapper(
  name: string | undefined,
  symbol: string | undefined,
): boolean {
  if (name !== undefined && name.toLowerCase().startsWith('wrapped ')) {
    return true;
  }
  return symbol !== undefined && /^w[A-Z][A-Za-z0-9]*$/.test(symbol);
}

// A version marker must be a separate suffix token, so "USD Coin v2" matches
// while ordinary names such as "Vitality" do not.
const VERSION_SUFFIX = /(?:^|[\s._-])v\d+(?:\.\d+)*$/i;

function hasVersionSuffix(name: string | undefined): boolean {
  return name !== undefined && VERSION_SUFFIX.test(name);
}

function reasonFor(
  token: NormalizedToken,
  name: string | undefined,
  symbol: string | undefined,
): ClassificationReason {
  if (token.watchlist === true) return 'watchlist';
  if (looksLikeWrapper(name, symbol)) return 'apparent-wrapper';
  if (hasVersionSuffix(name)) return 'versioned-name';

  const identity = identityState(name, symbol);
  if (identity === 'missing') return 'missing-identity';
  if (identity === 'ambiguous') return 'ambiguous-identity';

  const market = marketState(token);
  if (market === 'missing') return 'missing-market-cap';
  if (market === 'unusable') return 'unusable-market-cap';
  return 'peer';
}

function flagsFor(
  token: NormalizedToken,
  name: string | undefined,
  symbol: string | undefined,
  reason: ClassificationReason,
): readonly LedgerFlag[] {
  const flags: LedgerFlag[] = [];

  if (looksLikeWrapper(name, symbol)) flags.push('apparent-wrapper');
  if (hasVersionSuffix(name)) flags.push('versioned-name');

  const identity = identityState(name, symbol);
  if (identity === 'missing') flags.push('missing-identity');
  if (identity === 'ambiguous') flags.push('ambiguous-identity');

  const market = marketState(token);
  if (market === 'missing') flags.push('missing-market-cap');
  if (market === 'unusable') flags.push('unusable-market-cap');

  if (normalizeText(token.listedAt) === undefined) flags.push('missing-listed-at');
  if (token.change7d == null) flags.push('missing-change-7d');

  return Object.freeze(flags.filter((flag) => flag !== reason));
}

function buildRow(token: NormalizedToken, slug: string): LedgerRow {
  const name = normalizeText(token.name);
  const symbol = normalizeText(token.symbol);
  const reason = reasonFor(token, name, symbol);
  const status = reason === 'peer' ? 'peer' : 'candidate';

  return Object.freeze({
    slug,
    status,
    reason,
    flags: flagsFor(token, name, symbol, reason),
    token: Object.freeze({ ...token }),
  });
}

export function classify(snapshot: NormalizedSnapshot): ClassificationResult {
  const seen = new Map<string, number>();
  const duplicateSlugs = new Set<string>();
  const keyedTokens: Array<{ slug: string; token: NormalizedToken }> = [];

  for (const [index, token] of snapshot.tokens.entries()) {
    const slug = normalizeText(token.slug);
    if (slug === undefined) throw new InvalidSlugError(index);

    const priorCount = seen.get(slug);

    if (priorCount === undefined) {
      seen.set(slug, 1);
    } else {
      seen.set(slug, priorCount + 1);
      duplicateSlugs.add(slug);
    }

    keyedTokens.push({ slug, token });
  }

  if (duplicateSlugs.size > 0) {
    throw new DuplicateSlugError([...duplicateSlugs].sort(compareSlugs));
  }

  const ledger = keyedTokens
    .map(({ slug, token }) => buildRow(token, slug))
    .sort((left, right) => compareSlugs(left.slug, right.slug));

  return {
    candidates: ledger.filter((row) => row.status === 'candidate'),
    peers: ledger.filter((row) => row.status === 'peer'),
    ledger,
  };
}
