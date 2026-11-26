/**
 * Independent local release gate for Token Radar output directories.
 *
 * It reads only files on disk: no vendor CLI, no installs, no network, no
 * credentials, no submission. It checks the file-gate shape documented in the
 * kit's RULES.txt, then compares two runs byte for byte.
 *
 * It is deliberately not the sealed make.fun grader. It does not render the
 * dashboard, take screenshots, run the program, or rebuild
 * `buildDossier` byte for byte. Those remain real-browser / official-grader
 * checks.
 *
 * CLI:
 *   node tools/check-local.ts <snapshot> <output-a> <output-b>
 *
 * The snapshot digest is the kit's pinned digest. Synthetic fixtures may set
 * TOKEN_RADAR_SNAPSHOT_SHA256 to their own digest.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const OFFICIAL_SNAPSHOT_SHA256 =
  '42a71213519479f3a180cc5010cbbf6bd18a2447fa0ad29e4c5122b6c9184393';

export const BOARD_MIN_ROWS = 100;
export const BOARD_MAX_ROWS = 4_000;
export const BOARD_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_IMPLIED_USD = 100_000_000_000_000;

export const DASHBOARD_MAX_FILES = 400;
export const DASHBOARD_MAX_BYTES = 4 * 1024 * 1024;
export const DASHBOARD_SOURCE_WARN_BYTES = 65_536;

export const SCREENSHOT_MAX_BYTES = 512 * 1024;
export const SCREENSHOT_NAMES = ['1-board.png', '2-detail.png', '3-filtered.png'] as const;

/** The gate's dossier cap (RULES.txt says 1.5 MiB; the library's internal cap is larger). */
export const DOSSIER_MAX_BYTES = 1_572_864; // 1.5 MiB
export const DOSSIER_TEXT_MAX_BYTES = 65_536;
export const DOSSIER_MAX_IMAGES = 8;

export const SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
export const MANIFEST_MAX_FILES = 5_000;
export const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;

const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const HTTP_ADDRESS = /https?:\/\//i;

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface OutputReport {
  readonly root: string;
  readonly checks: readonly CheckResult[];
  readonly warnings: readonly string[];
}

export interface SnapshotInfo {
  readonly path: string;
  readonly sha256: string;
  readonly asOf: string;
  readonly floorUsd: number;
  readonly protocols: ReadonlySet<string>;
  readonly watchlist: readonly string[];
}

interface WalkedFile {
  readonly rel: string;
  readonly abs: string;
  readonly size: number;
}

interface WalkOptions {
  readonly maxFiles: number;
  readonly maxDirs: number;
  readonly maxBytes: number;
  readonly plainNames: boolean;
  readonly dotDirs: 'fail' | 'allow';
}

interface BoardRow {
  readonly slug: string;
  readonly rank: number;
  readonly implied: number;
  readonly farmSteps: readonly unknown[];
}

interface DashboardInfo {
  readonly files: readonly WalkedFile[];
  readonly totalBytes: number;
  readonly sourceBytes: number;
}

interface ShotInfo {
  readonly name: string;
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  readonly mediaType: 'image/png' | 'image/jpeg';
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const clip = (value: string, max = 180): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sha256Hex = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

const pass = (id: string, detail: string): CheckResult => ({ id, status: 'pass', detail });
const fail = (id: string, detail: string): CheckResult => ({ id, status: 'fail', detail });
const skip = (id: string, detail: string): CheckResult => ({ id, status: 'skip', detail });

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function lstatNoFollow(path: string, label: string): ReturnType<typeof lstatSync> {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} is missing or cannot be read`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} is a symbolic link or reparse point; traversal refused`);
  }
  return stat;
}

function requireDirectory(path: string, label: string): void {
  const stat = lstatNoFollow(path, label);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory`);
}

function readCapped(path: string, cap: number, label: string): Buffer {
  const stat = lstatNoFollow(path, label);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
  if (stat.size > cap) {
    throw new Error(`${label} is ${stat.size} bytes, over the ${cap}-byte cap`);
  }
  const bytes = readFileSync(path);
  if (bytes.length > cap) {
    throw new Error(`${label} is ${bytes.length} bytes, over the ${cap}-byte cap`);
  }
  return bytes;
}

function walkTree(root: string, options: WalkOptions): WalkedFile[] {
  requireDirectory(root, root);
  const files: WalkedFile[] = [];
  let totalBytes = 0;
  let directories = 0;
  const stack: string[] = [''];

  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = rel === '' ? root : join(root, rel);
    let entries: ReturnType<typeof readdirSync<{ withFileTypes: true }>>;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      throw new Error(`${rel === '' ? root : rel} cannot be read`);
    }
    entries.sort((a, b) => byCodeUnit(a.name, b.name));

    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const childAbs = join(root, childRel);
      const stat = lstatNoFollow(childAbs, childRel);

      if (stat.isDirectory()) {
        if (options.dotDirs === 'fail' && entry.name.startsWith('.')) {
          throw new Error(`${childRel} is a dot-directory, which the dashboard refuses`);
        }
        directories++;
        if (directories > options.maxDirs) {
          throw new Error(`${root} holds more than the ${options.maxDirs} directories it may`);
        }
        stack.push(childRel);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`${childRel} is neither a regular file nor a directory`);
      }
      if (options.plainNames && !PLAIN_NAME.test(entry.name)) {
        throw new Error(
          `${childRel}: a file's name is letters, digits and . _ -, 1 to 128 characters, not starting with . or -`,
        );
      }
      files.push({ rel: childRel, abs: childAbs, size: stat.size });
      totalBytes += stat.size;
      if (files.length > options.maxFiles) {
        throw new Error(`${root} holds more than the ${options.maxFiles} files it may`);
      }
      if (totalBytes > options.maxBytes) {
        throw new Error(`${root}'s files come to more than the ${options.maxBytes} bytes they may`);
      }
    }
  }

  files.sort((a, b) => byCodeUnit(a.rel, b.rel));
  return files;
}

// ---------------------------------------------------------------- snapshot

export function loadSnapshot(
  path: string,
  expectedSha256: string = process.env.TOKEN_RADAR_SNAPSHOT_SHA256 ?? OFFICIAL_SNAPSHOT_SHA256,
): SnapshotInfo {
  const expected = expectedSha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error('expected snapshot sha256 must be 64 hexadecimal characters');
  }

  const abs = resolve(path);
  const bytes = readCapped(abs, SNAPSHOT_MAX_BYTES, 'snapshot');
  const digest = sha256Hex(bytes);
  if (digest !== expected) {
    throw new Error(`snapshot sha256 is ${digest}, not the pinned ${expected}`);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(decodeUtf8(bytes, 'snapshot'));
  } catch (error) {
    if (error instanceof Error && /UTF-8/.test(error.message)) throw error;
    throw new Error('snapshot is not valid JSON');
  }
  if (!isRecord(doc)) throw new Error('snapshot is not a JSON object');

  if (typeof doc.as_of !== 'string' || doc.as_of.length === 0) {
    throw new Error('snapshot.as_of must be a non-empty string');
  }
  if (typeof doc.source !== 'string' || doc.source.length === 0) {
    throw new Error('snapshot.source must be a non-empty string');
  }
  if (!Number.isSafeInteger(doc.floor_usd) || (doc.floor_usd as number) <= 0) {
    throw new Error('snapshot.floor_usd must be a positive whole number');
  }
  if (!Array.isArray(doc.protocols) || doc.protocols.length === 0) {
    throw new Error('snapshot.protocols must be a non-empty array');
  }
  if (!Array.isArray(doc.watchlist) || doc.watchlist.length === 0) {
    throw new Error('snapshot.watchlist must be a non-empty array');
  }

  const protocols = new Set<string>();
  for (const [index, value] of doc.protocols.entries()) {
    if (!isRecord(value) || typeof value.slug !== 'string') {
      throw new Error(`snapshot.protocols[${index}] has no string slug`);
    }
    const slug = value.slug;
    if (slug.length < 1 || slug.length > 128 || /\s/.test(slug)) {
      throw new Error(`snapshot.protocols[${index}].slug is not a 1 to 128 character non-whitespace slug`);
    }
    if (protocols.has(slug)) throw new Error(`snapshot.protocols repeats slug "${slug}"`);
    protocols.add(slug);
  }

  const seenWatchlist = new Set<string>();
  const watchlist: string[] = [];
  for (const [index, value] of doc.watchlist.entries()) {
    if (typeof value !== 'string') {
      throw new Error(`snapshot.watchlist[${index}] is not a string`);
    }
    if (!protocols.has(value)) {
      throw new Error(`snapshot.watchlist slug "${value}" does not name a protocol`);
    }
    if (seenWatchlist.has(value)) {
      throw new Error(`snapshot.watchlist repeats slug "${value}"`);
    }
    seenWatchlist.add(value);
    watchlist.push(value);
  }

  return {
    path: abs,
    sha256: digest,
    asOf: doc.as_of,
    floorUsd: doc.floor_usd as number,
    protocols,
    watchlist,
  };
}

// ---------------------------------------------------------------- board

function readBoardRows(
  root: string,
  snapshot: SnapshotInfo,
): { rows: BoardRow[] } {
  const bytes = readCapped(join(root, 'board.json'), BOARD_MAX_BYTES, 'board.json');
  let doc: unknown;
  try {
    doc = JSON.parse(decodeUtf8(bytes, 'board.json'));
  } catch (error) {
    if (error instanceof Error && /UTF-8/.test(error.message)) throw error;
    throw new Error('board.json is not valid JSON');
  }

  let raw: unknown[];
  if (Array.isArray(doc)) raw = doc;
  else if (isRecord(doc) && Array.isArray(doc.rows)) raw = doc.rows;
  else throw new Error('board.json must be an object whose rows is an array, or a bare array of rows');

  if (raw.length < BOARD_MIN_ROWS || raw.length > BOARD_MAX_ROWS) {
    throw new Error(
      `board.json holds ${raw.length} rows; the gate requires ${BOARD_MIN_ROWS} to ${BOARD_MAX_ROWS.toLocaleString('en-US')}`,
    );
  }

  const rows: BoardRow[] = [];
  const slugs = new Set<string>();
  for (const [index, value] of raw.entries()) {
    const where = `board.json rows[${index}]`;
    if (!isRecord(value)) throw new Error(`${where} is not an object`);

    const slug = value.slug;
    if (typeof slug !== 'string' || slug.length < 1 || slug.length > 128 || /\s/.test(slug)) {
      throw new Error(`${where}.slug must be a 1 to 128 character string with no whitespace`);
    }
    if (!snapshot.protocols.has(slug)) {
      throw new Error(`${where}.slug "${slug}" is not in the snapshot; an unknown slug is invented`);
    }
    if (slugs.has(slug)) throw new Error(`${where}.slug "${slug}" is repeated; every slug appears once`);
    slugs.add(slug);

    if (typeof value.name !== 'string' || value.name.length === 0) {
      throw new Error(`${where}.name must be a non-empty string`);
    }
    if (!Number.isSafeInteger(value.rank) || (value.rank as number) <= 0) {
      throw new Error(`${where}.rank must be a positive whole number`);
    }
    if (
      !Number.isSafeInteger(value.implied_value_usd) ||
      (value.implied_value_usd as number) <= 0 ||
      (value.implied_value_usd as number) > MAX_IMPLIED_USD
    ) {
      throw new Error(
        `${where}.implied_value_usd must be a positive whole number of dollars, at most ${MAX_IMPLIED_USD.toLocaleString('en-US')}`,
      );
    }
    if (!Array.isArray(value.farm_steps)) {
      throw new Error(`${where}.farm_steps must be an array`);
    }

    rows.push({
      slug,
      rank: value.rank as number,
      implied: value.implied_value_usd as number,
      farmSteps: value.farm_steps,
    });
  }

  return { rows };
}

function boardChecks(root: string, snapshot: SnapshotInfo): CheckResult[] {
  let rows: BoardRow[];
  try {
    ({ rows } = readBoardRows(root, snapshot));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [
      fail('board_file', detail),
      skip('sorted_by_value', 'board rows are unavailable because board_file failed'),
      skip('coverage', 'board rows are unavailable because board_file failed'),
      skip('farm_steps', 'board rows are unavailable because board_file failed'),
    ];
  }

  const results: CheckResult[] = [
    pass(
      'board_file',
      `${rows.length} rows; every slug is a snapshot protocol; fields, ranks and value types are in shape`,
    ),
  ];

  const ordered = [...rows].sort((a, b) => a.rank - b.rank);
  let sortedProblem: string | null = null;
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i]!.rank !== i + 1) {
      sortedProblem = `ranks are not exactly 1 to ${ordered.length}: position ${i + 1} has rank ${ordered[i]!.rank}`;
      break;
    }
    if (i > 0 && ordered[i]!.implied > ordered[i - 1]!.implied) {
      sortedProblem = `implied_value_usd does not rise as rank ascends: rank ${ordered[i]!.rank} is above rank ${ordered[i - 1]!.rank}`;
      break;
    }
  }
  if (sortedProblem === null && ordered.length >= 2 && new Set(ordered.map((row) => row.implied)).size === 1) {
    sortedProblem = 'every implied_value_usd is the same; a board that ranks nothing by value is refused';
  }
  results.push(
    sortedProblem
      ? fail('sorted_by_value', sortedProblem)
      : pass('sorted_by_value', `ranks 1..${ordered.length}, implied values non-increasing`),
  );

  const present = new Set(rows.map((row) => row.slug));
  const missing = snapshot.watchlist.filter((slug) => !present.has(slug));
  results.push(
    missing.length === 0
      ? pass('coverage', `${snapshot.watchlist.length}/${snapshot.watchlist.length} watchlist slugs present`)
      : fail(
          'coverage',
          `watchlist coverage ${snapshot.watchlist.length - missing.length}/${snapshot.watchlist.length}; missing ${missing
            .slice(0, 8)
            .map((slug) => `"${slug}"`)
            .join(', ')}${missing.length > 8 ? ` and ${missing.length - 8} more` : ''}`,
        ),
  );

  let farmProblem: string | null = null;
  for (const row of rows) {
    const steps = row.farmSteps;
    if (steps.length < 3 || steps.length > 12) {
      farmProblem = `rank ${row.rank} (${row.slug}) has ${steps.length} farm_steps; the gate requires 3 to 12`;
      break;
    }
    for (const [index, step] of steps.entries()) {
      if (typeof step !== 'string') {
        farmProblem = `rank ${row.rank} (${row.slug}) farm_steps[${index}] is not a string`;
        break;
      }
      const length = step.trim().length;
      if (length < 20 || length > 600) {
        farmProblem = `rank ${row.rank} (${row.slug}) farm_steps[${index}] is ${length} characters after trimming; the gate requires 20 to 600`;
        break;
      }
    }
    if (farmProblem !== null) break;
  }
  results.push(
    farmProblem
      ? fail('farm_steps', farmProblem)
      : pass('farm_steps', `${rows.length} rows; every plan has 3 to 12 steps of 20 to 600 trimmed characters`),
  );

  return results;
}

// ---------------------------------------------------------------- dashboard

function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Remove JavaScript comments while leaving string and template contents intact. */
function stripJsComments(source: string): string {
  let out = '';
  let i = 0;
  let quote = '';
  while (i < source.length) {
    const char = source[i]!;
    const next = source[i + 1];
    if (quote !== '') {
      out += char;
      if (char === '\\') {
        out += source[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (char === quote) quote = '';
      i++;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      out += char;
      i++;
      continue;
    }
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < source.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

/** HTML tags, respecting quoted > characters. Comments must already be removed. */
function htmlTags(html: string): string[] {
  const tags: string[] = [];
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf('<', i);
    if (open < 0) break;
    let j = open + 1;
    let quote = '';
    while (j < html.length) {
      const char = html[j]!;
      if (quote !== '') {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
      j++;
    }
    if (j >= html.length) break;
    tags.push(html.slice(open, j + 1));
    i = j + 1;
  }
  return tags;
}

function scanJsSpecifiers(source: string): string | null {
  const patterns = [
    /\bimport\s+(?:[^'";]*?\s+from\s*)?(['"])([^'"]+)\1/g,
    /\bexport\s+[^'";]*?\s+from\s*(['"])([^'"]+)\1/g,
    /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[2]!;
      if (HTTP_ADDRESS.test(specifier)) {
        return `a JavaScript import specifier names an external address (${clip(specifier, 100)})`;
      }
    }
  }
  return null;
}

function scanHtml(text: string): string | null {
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '');

  const attrPattern =
    /\b[A-Za-z_:][-A-Za-z0-9_:.]*\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const tag of htmlTags(withoutComments)) {
    let match: RegExpExecArray | null;
    attrPattern.lastIndex = 0;
    while ((match = attrPattern.exec(tag)) !== null) {
      const value = match[1] ?? match[2] ?? match[3] ?? '';
      if (HTTP_ADDRESS.test(value)) {
        return `an HTML attribute value names an external address (${clip(value, 100)})`;
      }
    }
  }

  const stylePattern = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = stylePattern.exec(withoutComments)) !== null) {
    const body = stripCssComments(match[1] ?? '');
    if (HTTP_ADDRESS.test(body)) return 'an HTML <style> body names an external address';
  }

  const scriptPattern = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  while ((match = scriptPattern.exec(withoutComments)) !== null) {
    const body = stripJsComments(match[1] ?? '');
    const problem = scanJsSpecifiers(body);
    if (problem !== null) return problem;
  }

  return null;
}

function inspectDashboard(root: string): { result: CheckResult; info?: DashboardInfo; warning?: string } {
  const dir = join(root, 'dashboard');
  let files: WalkedFile[];
  try {
    files = walkTree(dir, {
      maxFiles: DASHBOARD_MAX_FILES,
      maxDirs: 1_000,
      maxBytes: DASHBOARD_MAX_BYTES,
      plainNames: true,
      dotDirs: 'fail',
    });
  } catch (error) {
    return { result: fail('dashboard_files', error instanceof Error ? error.message : String(error)) };
  }

  const rels = new Set(files.map((file) => file.rel));
  if (!rels.has('index.html')) {
    return { result: fail('dashboard_files', 'dashboard/index.html is missing') };
  }
  if (!files.some((file) => file.rel.endsWith('.css'))) {
    return { result: fail('dashboard_files', 'dashboard/ holds no .css stylesheet') };
  }
  if (!files.some((file) => file.rel.endsWith('.js'))) {
    return { result: fail('dashboard_files', 'dashboard/ holds no .js script') };
  }

  let sourceBytes = 0;
  try {
    for (const file of files) {
      const ext = file.rel.slice(file.rel.lastIndexOf('.') + 1).toLowerCase();
      if (ext !== 'html' && ext !== 'css' && ext !== 'js' && ext !== 'mjs') continue;
      sourceBytes += file.size;
      const bytes = readCapped(file.abs, DASHBOARD_MAX_BYTES, `dashboard/${file.rel}`);
      const text = bytes.toString('utf8');
      const problem =
        ext === 'html' ? scanHtml(text) : ext === 'css' ? (HTTP_ADDRESS.test(stripCssComments(text)) ? 'a CSS file names an external address' : null) : scanJsSpecifiers(stripJsComments(text));
      if (problem !== null) throw new Error(`dashboard/${file.rel}: ${problem}`);
    }
  } catch (error) {
    return { result: fail('dashboard_files', error instanceof Error ? error.message : String(error)) };
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const warning =
    sourceBytes > DASHBOARD_SOURCE_WARN_BYTES
      ? `dashboard source is ${sourceBytes} bytes; the dossier text (65,536 bytes) will be cut, so the judge reads a partial source`
      : undefined;
  return {
    result: pass(
      'dashboard_files',
      `${files.length} files, ${totalBytes} bytes, index.html + .css + .js, plain names, no external references`,
    ),
    info: { files, totalBytes, sourceBytes },
    warning,
  };
}

// ---------------------------------------------------------------- screenshots

function isSofMarker(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function imageInfo(bytes: Buffer): { mediaType: 'image/png' | 'image/jpeg'; width: number; height: number } {
  if (
    bytes.length >= 33 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error('PNG does not open with a 13-byte IHDR chunk');
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width === 0 || height === 0) throw new Error('PNG IHDR has a zero dimension');
    const end = bytes.length - 12;
    if (end < 8 || bytes.readUInt32BE(end) !== 0 || bytes.toString('ascii', end + 4, end + 8) !== 'IEND') {
      throw new Error('PNG has no terminal IEND chunk; the file is truncated or not a whole PNG');
    }
    return { mediaType: 'image/png', width, height };
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
      throw new Error('JPEG has no terminal EOI marker; the file is truncated or not a whole JPEG');
    }
    let offset = 2;
    let width = 0;
    let height = 0;
    let guard = 0;
    while (offset + 3 < bytes.length && guard++ < 100_000) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++]!;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) throw new Error('JPEG segment is truncated');
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error('JPEG segment length is invalid');
      if (isSofMarker(marker)) {
        if (length < 7) throw new Error('JPEG frame header is too short');
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
      }
      offset += length;
    }
    if (width === 0 || height === 0) throw new Error('JPEG has no frame header with dimensions');
    return { mediaType: 'image/jpeg', width, height };
  }

  throw new Error('file is neither a PNG nor a JPEG');
}

function inspectScreenshots(root: string): { result: CheckResult; info?: ShotInfo[]; warning?: string } {
  const dir = join(root, 'screenshots');
  let entries: ReturnType<typeof readdirSync<{ withFileTypes: true }>>;
  try {
    requireDirectory(dir, 'screenshots');
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return { result: fail('screenshots', error instanceof Error ? error.message : String(error)) };
  }
  entries.sort((a, b) => byCodeUnit(a.name, b.name));
  const visible = entries.filter((entry) => !entry.name.startsWith('.'));

  if (visible.length < 3 || visible.length > 4) {
    return {
      result: fail('screenshots', `screenshots/ holds ${visible.length} visible entries; the gate requires 3 to 4 images`),
    };
  }
  const names = visible.map((entry) => entry.name);
  const expected = [...SCREENSHOT_NAMES];
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    return {
      result: fail(
        'screenshots',
        `project profile requires exactly ${expected.join(', ')}; found ${names.join(', ')} (the official gate also accepts 3-4 PNG/JPEG with plain names)`,
      ),
    };
  }

  const shots: ShotInfo[] = [];
  try {
    for (const entry of visible) {
      if (!PLAIN_NAME.test(entry.name)) {
        throw new Error(`screenshots/${entry.name}: a file's name is letters, digits and . _ -, 1 to 128 characters`);
      }
      const stat = lstatNoFollow(join(dir, entry.name), `screenshots/${entry.name}`);
      if (!stat.isFile()) throw new Error(`screenshots/${entry.name} is not a regular file`);
      const bytes = readCapped(join(dir, entry.name), SCREENSHOT_MAX_BYTES, `screenshots/${entry.name}`);
      const meta = imageInfo(bytes);
      if (meta.mediaType !== 'image/png') {
        throw new Error(`screenshots/${entry.name} is a JPEG; the project profile requires PNG`);
      }
      const longSide = Math.max(meta.width, meta.height);
      const shortSide = Math.min(meta.width, meta.height);
      if (longSide > 1440 || shortSide < 800) {
        throw new Error(
          `screenshots/${entry.name} is ${meta.width}x${meta.height}; the gate requires a long side at most 1440 and a short side at least 800`,
        );
      }
      shots.push({ name: entry.name, bytes, ...meta });
    }
  } catch (error) {
    return { result: fail('screenshots', error instanceof Error ? error.message : String(error)) };
  }

  return {
    result: pass(
      'screenshots',
      `${shots.length} PNGs (${shots.map((shot) => `${shot.width}x${shot.height}`).join(', ')}), each at most 512 KiB; project profile`,
    ),
    info: shots,
    warning:
      'screenshots: the local profile requires exactly the three starter-named PNGs; the official gate also accepts 3-4 PNG/JPEG. This checks file headers only; visual/render checks need a real browser.',
  };
}

// ---------------------------------------------------------------- dossier

function dashboardHead(files: readonly WalkedFile[]): string {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  return [
    '## Dashboard',
    '',
    `Files: ${files.length} (${total} bytes)`,
    ...files.map((file) => `- ${file.rel} (${file.size} bytes)`),
    '',
    '## Source',
    '',
    '',
  ].join('\n');
}

function inspectDossier(
  root: string,
  dashboard: DashboardInfo | undefined,
  shots: readonly ShotInfo[] | undefined,
): { result: CheckResult; warning?: string } {
  let bytes: Buffer;
  try {
    bytes = readCapped(join(root, 'dossier.json'), DOSSIER_MAX_BYTES, 'dossier.json');
  } catch (error) {
    return { result: fail('dossier_matches_local', error instanceof Error ? error.message : String(error)) };
  }

  let doc: unknown;
  try {
    doc = JSON.parse(decodeUtf8(bytes, 'dossier.json'));
  } catch (error) {
    return {
      result: fail(
        'dossier_matches_local',
        error instanceof Error && /UTF-8/.test(error.message) ? error.message : 'dossier.json is not valid JSON',
      ),
    };
  }
  if (!isRecord(doc)) return { result: fail('dossier_matches_local', 'dossier.json is not a JSON object') };
  if (doc.schema !== 'makefun/dossier/v1') {
    return { result: fail('dossier_matches_local', `dossier.schema is ${String(doc.schema)}, not makefun/dossier/v1`) };
  }
  if (doc.cover !== 0) {
    return { result: fail('dossier_matches_local', 'dossier.cover must be 0: the first screenshot by name is the cover') };
  }
  if (typeof doc.text !== 'string') {
    return { result: fail('dossier_matches_local', 'dossier.text must be a string') };
  }
  const textBytes = Buffer.byteLength(doc.text, 'utf8');
  if (textBytes > DOSSIER_TEXT_MAX_BYTES) {
    return {
      result: fail(
        'dossier_matches_local',
        `dossier.text is ${textBytes} UTF-8 bytes, over the 65,536-byte cap`,
      ),
    };
  }
  if (dashboard !== undefined && !doc.text.startsWith(dashboardHead(dashboard.files))) {
    return {
      result: fail(
        'dossier_matches_local',
        'dossier.text does not open with the documented ## Dashboard block (file count, bytes and path/size list) for the current dashboard/',
      ),
    };
  }

  if (shots === undefined) {
    return { result: skip('dossier_matches_local', 'screenshots are unavailable, so dossier image bytes cannot be checked') };
  }
  if (!Array.isArray(doc.images)) {
    return { result: fail('dossier_matches_local', 'dossier.images must be an array') };
  }
  if (doc.images.length !== shots.length) {
    return {
      result: fail(
        'dossier_matches_local',
        `dossier.images holds ${doc.images.length} images, but screenshots/ holds ${shots.length}`,
      ),
    };
  }
  if (doc.images.length > DOSSIER_MAX_IMAGES) {
    return { result: fail('dossier_matches_local', `dossier.images holds more than ${DOSSIER_MAX_IMAGES}`) };
  }

  for (const [index, expectedShot] of shots.entries()) {
    const image = doc.images[index];
    if (!isRecord(image)) {
      return { result: fail('dossier_matches_local', `dossier.images[${index}] is not an object`) };
    }
    if (image.name !== expectedShot.name) {
      return {
        result: fail(
          'dossier_matches_local',
          `dossier.images[${index}].name is ${String(image.name)}, not "${expectedShot.name}" in name order`,
        ),
      };
    }
    if (image.media_type !== expectedShot.mediaType) {
      return {
        result: fail(
          'dossier_matches_local',
          `dossier.images[${index}].media_type is ${String(image.media_type)}, not ${expectedShot.mediaType}`,
        ),
      };
    }
    if (typeof image.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(image.sha256)) {
      return { result: fail('dossier_matches_local', `dossier.images[${index}].sha256 is not 64 lowercase hex characters`) };
    }
    const actualSha = sha256Hex(expectedShot.bytes);
    if (image.sha256 !== actualSha) {
      return {
        result: fail(
          'dossier_matches_local',
          `dossier.images[${index}].sha256 does not match the actual screenshot bytes (${actualSha})`,
        ),
      };
    }
    if (typeof image.base64 !== 'string') {
      return { result: fail('dossier_matches_local', `dossier.images[${index}].base64 is not a string`) };
    }
    const decoded = Buffer.from(image.base64, 'base64');
    if (decoded.toString('base64') !== image.base64) {
      return { result: fail('dossier_matches_local', `dossier.images[${index}].base64 is not canonical base64`) };
    }
    if (!decoded.equals(expectedShot.bytes)) {
      return {
        result: fail(
          'dossier_matches_local',
          `dossier.images[${index}].base64 bytes differ from screenshots/${expectedShot.name}`,
        ),
      };
    }
  }

  const detail = `${doc.images.length} images match screenshot bytes and sha256; text ${textBytes}/65,536 UTF-8 bytes; schema and cover 0`;
  return {
    result: pass('dossier_matches_local', detail),
    warning:
      'dossier_matches_local is a structural local check: it verifies caps, cover, documented Dashboard block, image bytes, sha256 and base64. It does not rebuild byte-for-byte buildDossier text; only the sealed grader proves that.',
  };
}

// ---------------------------------------------------------------- output report

export function inspectOutput(root: string, snapshot: SnapshotInfo): OutputReport {
  const absRoot = resolve(root);
  const warnings: string[] = [];

  const dashboard = inspectDashboard(absRoot);
  const screenshots = inspectScreenshots(absRoot);
  if (dashboard.warning !== undefined) warnings.push(dashboard.warning);
  if (screenshots.warning !== undefined) warnings.push(screenshots.warning);

  const dossier = inspectDossier(absRoot, dashboard.info, screenshots.info);
  if (dossier.warning !== undefined) warnings.push(dossier.warning);

  return {
    root: absRoot,
    checks: [
      dashboard.result,
      ...boardChecks(absRoot, snapshot),
      screenshots.result,
      dossier.result,
    ],
    warnings,
  };
}

// ---------------------------------------------------------------- reruns

function manifest(root: string): Map<string, { size: number; sha256: string }> {
  const files = walkTree(root, {
    maxFiles: MANIFEST_MAX_FILES,
    maxDirs: MANIFEST_MAX_FILES,
    maxBytes: MANIFEST_MAX_BYTES,
    plainNames: false,
    dotDirs: 'allow',
  });
  const map = new Map<string, { size: number; sha256: string }>();
  for (const file of files) {
    const bytes = readCapped(file.abs, MANIFEST_MAX_BYTES, file.rel);
    if (bytes.length !== file.size) {
      throw new Error(`${file.rel} changed size while the manifest was read`);
    }
    map.set(file.rel, { size: file.size, sha256: sha256Hex(bytes) });
  }
  return map;
}

export function compareReruns(a: string, b: string): CheckResult {
  let left: Map<string, { size: number; sha256: string }>;
  let right: Map<string, { size: number; sha256: string }>;
  try {
    left = manifest(resolve(a));
    right = manifest(resolve(b));
  } catch (error) {
    return fail('rerun_identical', error instanceof Error ? error.message : String(error));
  }

  const leftPaths = [...left.keys()].sort(byCodeUnit);
  const rightPaths = [...right.keys()].sort(byCodeUnit);
  const onlyLeft = leftPaths.filter((path) => !right.has(path));
  const onlyRight = rightPaths.filter((path) => !left.has(path));
  if (onlyLeft.length > 0 || onlyRight.length > 0) {
    const parts: string[] = [];
    if (onlyLeft.length > 0) parts.push(`only in A: ${onlyLeft.slice(0, 8).join(', ')}`);
    if (onlyRight.length > 0) parts.push(`only in B: ${onlyRight.slice(0, 8).join(', ')}`);
    return fail('rerun_identical', `relative file lists differ; ${parts.join('; ')}`);
  }

  const changed = leftPaths.filter((path) => {
    const l = left.get(path)!;
    const r = right.get(path)!;
    return l.size !== r.size || l.sha256 !== r.sha256;
  });
  if (changed.length > 0) {
    return fail(
      'rerun_identical',
      `file bytes differ between runs (same relative path, different sha256): ${changed.slice(0, 8).join(', ')}`,
    );
  }

  const totalBytes = leftPaths.reduce((sum, path) => sum + left.get(path)!.size, 0);
  return pass('rerun_identical', `${leftPaths.length} relative files, ${totalBytes} bytes, identical sha256`);
}

// ---------------------------------------------------------------- CLI

const CHECKER_BANNER =
  'Token Radar independent local release gate. Not the sealed make.fun grader.';
const CHECKER_LIMITS =
  'File-level checks only: no program execution, no page render, no screenshot capture, no network, no submission. Visual/render checks need a real browser.';

function printUsage(stream: 'out' | 'err' = 'out'): void {
  const text = [
    'usage: node tools/check-local.ts <snapshot> <output-a> <output-b>',
    '',
    'Checks both output directories against the documented local file gates,',
    'then compares their sorted relative file lists and per-file sha256 digests.',
    `The snapshot digest is pinned to ${OFFICIAL_SNAPSHOT_SHA256}.`,
    'For synthetic fixtures set TOKEN_RADAR_SNAPSHOT_SHA256 to the fixture digest.',
    'Exit codes: 0 all local checks pass; 1 a gate or rerun check failed; 2 usage or snapshot failure.',
  ].join('\n');
  if (stream === 'err') console.error(text);
  else console.log(text);
}

function printReport(label: string, report: OutputReport): void {
  console.log(`\n[${label}] ${report.root}`);
  for (const result of report.checks) {
    console.log(`  ${result.status.toUpperCase().padEnd(4)} ${result.id}  ${clip(result.detail, 240)}`);
  }
  for (const warning of report.warnings) console.log(`  NOTE ${warning}`);
}

export function runCli(argv: readonly string[]): number {
  if (argv.length === 1 && (argv[0] === '-h' || argv[0] === '--help')) {
    printUsage();
    return 0;
  }
  if (argv.length !== 3) {
    printUsage('err');
    return 2;
  }

  const [snapshotArg, outputA, outputB] = argv as [string, string, string];
  console.log(CHECKER_BANNER);
  console.log(CHECKER_LIMITS);

  let snapshot: SnapshotInfo;
  try {
    snapshot = loadSnapshot(snapshotArg);
  } catch (error) {
    console.error(`SNAPSHOT FAIL ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  console.log(`\nSNAPSHOT PASS ${snapshot.path} sha256 ${snapshot.sha256}`);
  console.log(
    `snapshot ${snapshot.asOf}, floor $${snapshot.floorUsd.toLocaleString('en-US')}, ${snapshot.protocols.size} protocols, ${snapshot.watchlist.length} watchlist slugs`,
  );

  const reportA = inspectOutput(outputA, snapshot);
  const reportB = inspectOutput(outputB, snapshot);
  printReport('A', reportA);
  printReport('B', reportB);

  const rerun = compareReruns(outputA, outputB);
  console.log(`\n[rerun] ${rerun.status.toUpperCase()} rerun_identical  ${clip(rerun.detail, 240)}`);

  const all = [...reportA.checks, ...reportB.checks, rerun];
  const failures = all.filter((result) => result.status === 'fail');
  const skipped = all.filter((result) => result.status === 'skip');
  const passes = all.filter((result) => result.status === 'pass');
  const ok = failures.length === 0 && skipped.length === 0;
  console.log(
    `\nRESULT: ${ok ? 'PASS' : 'FAIL'} (${passes.length} pass, ${failures.length} fail, ${skipped.length} skip)`,
  );
  if (!ok) {
    if (failures.length > 0) {
      console.log(`failed: ${[...new Set(failures.map((result) => result.id))].join(', ')}`);
    }
    if (skipped.length > 0) {
      console.log(`unverified: ${[...new Set(skipped.map((result) => result.id))].join(', ')}`);
    }
    return 1;
  }
  console.log('Both runs are valid by the local file gate and byte-identical; this does not replace the sealed grader or a browser render check.');
  return 0;
}

const entry = process.argv[1] === undefined ? '' : pathToFileURL(process.argv[1]).href;
if (import.meta.url === entry) {
  process.exitCode = runCli(process.argv.slice(2));
}
