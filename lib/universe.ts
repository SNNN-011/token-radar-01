/**
 * Token Radar normalized-snapshot partition core.
 *
 * PROVISIONAL: no official Token Radar kit or ingest adapter is present in this
 * repository. This module consumes an internal normalized shape only; it does
 * not guess undocumented upstream keys and does not validate slugs against an
 * authoritative universe (that belongs to later ingest/board validation).
 *
 * Classification rules:
 * - A usable market cap is a positive finite number.
 * - A usable market cap or a nonblank geckoId is a strong token signal.
 * - A symbol by itself is weak/ambiguous and never confirms a token.
 * - A display name is display-only: it is never identity proof and is not
 *   required for peer status.
 * - Watchlist status overrides exclusion and preserves every signal as a flag.
 *
 * Iteration discipline: the core uses bounded array operations (map, reduce,
 * filter, sort) over the input array. There is no explicit loop state, no
 * retained mutable state, and the input length is the natural bound.
 */

export type LedgerStatus = 'peer' | 'candidate' | 'excluded';

export type CandidateReason = 'watchlist' | 'missing-token-metadata';

export type ExcludedReason =
  | 'apparent-wrapper'
  | 'versioned-name'
  | 'tokenized-without-usable-market-cap'
  | 'ambiguous-symbol-only'
  | 'missing-identity';

export type ClassificationReason =
  | 'peer'
  | CandidateReason
  | ExcludedReason;

export type LedgerFlag =
  | 'apparent-wrapper'
  | 'versioned-name'
  | 'tokenized-without-usable-market-cap'
  | 'ambiguous-symbol-only'
  | 'missing-token-metadata'
  | 'missing-identity'
  | 'missing-market-cap'
  | 'unusable-market-cap'
  | 'missing-listed-at'
  | 'missing-change-7d'
  | 'invalid-change-7d';

export interface NormalizedToken {
  readonly slug: string;
  readonly name?: string | null;
  readonly symbol?: string | null;
  readonly geckoId?: string | null;
  readonly marketCapUsd?: number | null;
  readonly tvlUsd?: number | null;
  readonly category?: string | null;
  readonly chains?: readonly string[] | null;
  readonly listedAt?: string | null;
  readonly change7d?: number | null;
  readonly watchlist?: boolean;
}

export interface NormalizedSnapshot {
  readonly tokens: readonly NormalizedToken[];
}

export interface LedgerRow {
  readonly slug: string;
  readonly status: LedgerStatus;
  readonly reason: ClassificationReason;
  readonly flags: readonly LedgerFlag[];
  readonly token: NormalizedToken;
}

export interface ClassificationResult {
  readonly candidates: readonly LedgerRow[];
  readonly peers: readonly LedgerRow[];
  readonly excluded: readonly LedgerRow[];
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
  readonly index: number;

  constructor(index: number) {
    super(
      `Token at index ${index} has an invalid slug; an exact, non-blank slug without outer whitespace is required`,
    );
    this.name = 'InvalidSlugError';
    this.index = index;
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

interface TokenSignals {
  readonly name: string | undefined;
  readonly symbol: string | undefined;
  readonly geckoId: string | undefined;
  readonly wrapper: boolean;
  readonly versioned: boolean;
  readonly market: MarketState;
  readonly usableMarketCap: boolean;
}

// Conservative wrapper signals only: the "Wrapped " display-name prefix or the
// lowercase-w/uppercase-next symbol convention (wETH, wBTC). An uppercase W is
// not enough evidence on its own (e.g. WIN).
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

function tokenSignals(token: NormalizedToken): TokenSignals {
  const name = normalizeText(token.name);
  const symbol = normalizeText(token.symbol);
  const geckoId = normalizeText(token.geckoId);
  const market = marketState(token);

  return {
    name,
    symbol,
    geckoId,
    wrapper: looksLikeWrapper(name, symbol),
    versioned: hasVersionSuffix(name),
    market,
    usableMarketCap: market === 'usable',
  };
}

// Watchlist wins over every exclusion. Wrapper/version are exclusions, not
// candidates. Missing token metadata is only a candidate when a display name
// exists; an ambiguous symbol by itself is excluded.
function reasonFor(
  signals: TokenSignals,
  watchlist: boolean,
): ClassificationReason {
  if (watchlist) return 'watchlist';
  if (signals.wrapper) return 'apparent-wrapper';
  if (signals.versioned) return 'versioned-name';
  if (signals.usableMarketCap) return 'peer';
  if (signals.geckoId !== undefined) {
    return 'tokenized-without-usable-market-cap';
  }
  if (signals.symbol !== undefined) return 'ambiguous-symbol-only';
  if (signals.name !== undefined) return 'missing-token-metadata';
  return 'missing-identity';
}

function statusFor(reason: ClassificationReason): LedgerStatus {
  if (reason === 'peer') return 'peer';
  if (reason === 'watchlist' || reason === 'missing-token-metadata') {
    return 'candidate';
  }
  return 'excluded';
}

function flagsFor(
  token: NormalizedToken,
  signals: TokenSignals,
  reason: ClassificationReason,
): readonly LedgerFlag[] {
  const flags: LedgerFlag[] = [];

  if (signals.wrapper) flags.push('apparent-wrapper');
  if (signals.versioned) flags.push('versioned-name');

  if (signals.geckoId !== undefined && !signals.usableMarketCap) {
    flags.push('tokenized-without-usable-market-cap');
  }
  if (
    !signals.usableMarketCap &&
    signals.geckoId === undefined &&
    signals.symbol !== undefined
  ) {
    flags.push('ambiguous-symbol-only');
  }

  if (reason !== 'peer') {
    if (
      signals.name === undefined &&
      signals.symbol === undefined &&
      signals.geckoId === undefined
    ) {
      flags.push('missing-identity');
    } else if (
      signals.name !== undefined &&
      signals.symbol === undefined &&
      signals.geckoId === undefined
    ) {
      flags.push('missing-token-metadata');
    }
  }

  if (signals.market === 'missing') flags.push('missing-market-cap');
  if (signals.market === 'unusable') flags.push('unusable-market-cap');

  // Date format is not defined by the normalized contract, so listedAt is
  // preserved raw. Only its absence/blankness is flagged; no format guessing.
  if (normalizeText(token.listedAt) === undefined) {
    flags.push('missing-listed-at');
  }

  if (token.change7d == null) {
    flags.push('missing-change-7d');
  } else if (
    typeof token.change7d !== 'number' ||
    !Number.isFinite(token.change7d)
  ) {
    flags.push('invalid-change-7d');
  }

  return Object.freeze(flags.filter((flag) => flag !== reason));
}

// Copy all modeled fields losslessly. chains is the only nested value, so it
// gets its own frozen array; no caller-owned reference is retained.
function copyToken(token: NormalizedToken): NormalizedToken {
  if (Array.isArray(token.chains)) {
    return Object.freeze({
      ...token,
      chains: Object.freeze([...token.chains]),
    });
  }
  return Object.freeze({ ...token });
}

function buildRow(token: NormalizedToken): LedgerRow {
  const signals = tokenSignals(token);
  const reason = reasonFor(signals, token.watchlist === true);

  return Object.freeze({
    slug: token.slug,
    status: statusFor(reason),
    reason,
    flags: flagsFor(token, signals, reason),
    token: copyToken(token),
  });
}

function assertExactSlug(token: NormalizedToken, index: number): void {
  const slug = token.slug;
  if (
    typeof slug !== 'string' ||
    slug.length === 0 ||
    slug.trim().length === 0 ||
    slug !== slug.trim()
  ) {
    throw new InvalidSlugError(index);
  }
}

export function classify(snapshot: NormalizedSnapshot): ClassificationResult {
  const keyedTokens = snapshot.tokens.map((token, index) => {
    assertExactSlug(token, index);
    return { slug: token.slug, token };
  });

  const slugCounts = keyedTokens.reduce((counts, entry) => {
    counts.set(entry.slug, (counts.get(entry.slug) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());

  const duplicateSlugs = [...slugCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([slug]) => slug)
    .sort(compareSlugs);

  if (duplicateSlugs.length > 0) {
    throw new DuplicateSlugError(duplicateSlugs);
  }

  const ledger = Object.freeze(
    keyedTokens
      .map(({ token }) => buildRow(token))
      .sort((left, right) => compareSlugs(left.slug, right.slug)),
  );
  const candidates = Object.freeze(
    ledger.filter((row) => row.status === 'candidate'),
  );
  const peers = Object.freeze(ledger.filter((row) => row.status === 'peer'));
  const excluded = Object.freeze(
    ledger.filter((row) => row.status === 'excluded'),
  );

  return Object.freeze({ candidates, peers, excluded, ledger });
}
