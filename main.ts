/**
 * Token Radar entrypoint (Node 22, standard library only).
 *
 * The program reads the sealed snapshot, runs the real snapshot adapter and
 * valuation benchmark, and assembles the single data document in
 * `lib/entry.ts`. It then writes:
 *
 *   /output/board.json       official board rows
 *   /output/data.js          globalThis.TOKEN_RADAR_DATA for dashboard/index.html
 *   /output/dashboard/       an exact copy of this repository's dashboard/
 *   /output/screenshots/     the three exact repository screenshots
 *   /output/dossier.json     the audited buildDossier result (full build only)
 *
 * Local modes:
 *   node main.ts --prepare --input <snapshot> --output <fresh dir>
 *     Writes board/data/dashboard and stops. It deliberately writes no
 *     screenshots and no dossier so a real browser can capture
 *     ../../screenshots/1-board.png, 2-detail.png and 3-filtered.png later.
 *     Nothing is fabricated in their place.
 *
 *   node main.ts --input <snapshot> --output <fresh dir>
 *     Full build: copies the repository's exact screenshots and calls the
 *     audited vendor `buildDossier` through a dynamic import.
 *
 * Input:  --input <file|directory> > MAKEFUN_INPUT_DIR > /input/snapshot.json
 * Output: --output > MAKEFUN_OUTPUT_DIR > /output
 *
 * Safety: the output directory must be missing or empty; no file is ever
 * deleted. Source dashboard and screenshot entries are read without following
 * symlinks. The pending farm and vendor modules are loaded dynamically so this
 * isolated branch fails clearly instead of shipping a stub.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { benchmarkValuation } from './lib/evaluation.ts';
import { adaptSnapshot } from './lib/snapshot.ts';
import { assemble, buildBoard, dataScript, BOARD_MAX_BYTES } from './lib/entry.ts';
import type { BoardRow, EntryData, FarmPlanner } from './lib/entry.ts';
import type { SnapshotReport } from './lib/snapshot.ts';

/** The scorer's caps; only text_max_bytes shapes dossier bytes. */
export const TEXT_MAX_BYTES = 65_536;
export const SCREENSHOT_MAX = 4;
export const SCREENSHOT_MAX_BYTES = 524_288;
export const DASHBOARD_MAX_FILES = 400;
export const DASHBOARD_MAX_BYTES = 4_194_304;
/** The official dossier gate cap (not the library's larger internal cap). */
export const DOSSIER_GATE_MAX_BYTES = 1_572_864;
export const SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
export const SCREENSHOT_NAMES = [
  '1-board.png',
  '2-detail.png',
  '3-filtered.png',
] as const;

const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

type Env = Readonly<Record<string, string | undefined>>;

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export interface CliOptions {
  readonly input?: string;
  readonly output?: string;
  readonly prepare: boolean;
  readonly help: boolean;
}

export type ModuleLoader = (specifier: string) => Promise<unknown>;

export interface DossierCaps {
  readonly text_max_bytes: number;
  readonly screenshots: { readonly max: number; readonly max_bytes: number };
  readonly dashboard: {
    readonly max_files: number;
    readonly max_bytes: number;
  };
}

export type DossierBuilder = (dir: string, caps: DossierCaps) => Uint8Array;

function optionValue(
  argv: readonly string[],
  index: number,
  name: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new CliUsageError(`--${name} needs a value`);
  }
  return value;
}

/** Parse only documented flags; a typo is a usage error, never ignored. */
export function parseCli(argv: readonly string[]): CliOptions {
  let input: string | undefined;
  let output: string | undefined;
  let prepare = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === '--prepare') {
      prepare = true;
    } else if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument === '--input') {
      input = optionValue(argv, index, 'input');
      index += 1;
    } else if (argument.startsWith('--input=')) {
      input = argument.slice('--input='.length);
      if (input.length === 0) throw new CliUsageError('--input needs a value');
    } else if (argument === '--output') {
      output = optionValue(argv, index, 'output');
      index += 1;
    } else if (argument.startsWith('--output=')) {
      output = argument.slice('--output='.length);
      if (output.length === 0) throw new CliUsageError('--output needs a value');
    } else {
      throw new CliUsageError(`unknown argument "${argument}"`);
    }
  }

  return { input, output, prepare, help };
}

/** `--input` accepts a file or a directory; the env var is a directory. */
export function resolveInputPath(
  inputArgument: string | undefined,
  env: Env = process.env,
): string {
  if (inputArgument !== undefined) {
    const absolute = resolve(inputArgument);
    if (existsSync(absolute)) {
      const stat = lstatSync(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        return join(absolute, 'snapshot.json');
      }
      return absolute;
    }
    if (inputArgument.endsWith('.json')) return absolute;
    return join(absolute, 'snapshot.json');
  }
  const directory = env.MAKEFUN_INPUT_DIR;
  if (typeof directory === 'string' && directory.length > 0) {
    const absolute = resolve(directory);
    if (existsSync(absolute)) {
      const stat = lstatSync(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        return join(absolute, 'snapshot.json');
      }
      return absolute;
    }
    return join(absolute, 'snapshot.json');
  }
  return resolve('/input/snapshot.json');
}

/** `--output` wins over `MAKEFUN_OUTPUT_DIR`, which wins over `/output`. */
export function resolveOutputPath(
  outputArgument: string | undefined,
  env: Env = process.env,
): string {
  if (outputArgument !== undefined) return resolve(outputArgument);
  const directory = env.MAKEFUN_OUTPUT_DIR;
  if (typeof directory === 'string' && directory.length > 0) {
    return resolve(directory);
  }
  return resolve('/output');
}

function readSourceFile(
  path: string,
  label: string,
  maxBytes: number,
): Buffer {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} is missing or cannot be read at ${path}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} is a symbolic link; source links are refused`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} is not a regular file`);
  }
  if (stat.size > maxBytes) {
    throw new Error(
      `${label} is ${stat.size} bytes, over the ${maxBytes}-byte cap`,
    );
  }
  return readFileSync(path);
}

function readSnapshot(path: string): unknown {
  const bytes = readSourceFile(path, 'snapshot', SNAPSHOT_MAX_BYTES);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('snapshot is not valid UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`snapshot at ${path} is not valid JSON`);
  }
  return parsed;
}

function moduleLoadFailure(label: string, error: unknown): Error {
  const code =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'ERR_MODULE_NOT_FOUND') {
    return new Error(
      `${label} is unavailable on this branch (pending component); merge its ` +
        `branch before writing output. Import failed: ${message}`,
    );
  }
  return new Error(`could not load ${label}: ${message}`);
}

/** Load `buildFarmPlan` from the pending farm branch, or fail clearly. */
export async function loadFarmPlanner(
  loader?: ModuleLoader,
): Promise<FarmPlanner> {
  let module: unknown;
  try {
    module =
      loader === undefined
        ? await import('./lib/farm.ts')
        : await loader('./lib/farm.ts');
  } catch (error) {
    throw moduleLoadFailure('lib/farm.ts', error);
  }
  if (
    typeof module !== 'object' ||
    module === null ||
    typeof (module as { buildFarmPlan?: unknown }).buildFarmPlan !== 'function'
  ) {
    throw new Error('lib/farm.ts does not export buildFarmPlan(row)');
  }
  return (module as { buildFarmPlan: FarmPlanner }).buildFarmPlan;
}

/** Load the audited dossier builder only for a full build. */
export async function loadDossierBuilder(
  loader?: ModuleLoader,
): Promise<DossierBuilder> {
  let module: unknown;
  try {
    module =
      loader === undefined
        ? await import('./vendor/makefun-board.ts')
        : await loader('./vendor/makefun-board.ts');
  } catch (error) {
    throw moduleLoadFailure('vendor/makefun-board.ts', error);
  }
  if (
    typeof module !== 'object' ||
    module === null ||
    typeof (module as { buildDossier?: unknown }).buildDossier !== 'function'
  ) {
    throw new Error('vendor/makefun-board.ts does not export buildDossier');
  }
  return (module as { buildDossier: DossierBuilder }).buildDossier;
}

function assertSourceDirectory(path: string, label: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} is missing at ${path}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} is a symbolic link; source links are refused`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory`);
  }
}

interface DashboardFile {
  readonly rel: string;
  readonly abs: string;
  readonly size: number;
}

export interface DashboardSource {
  readonly files: readonly DashboardFile[];
  readonly bytes: number;
}

/** Validate the dashboard tree and its official file/byte caps before writing. */
export function scanDashboard(repoRoot: string): DashboardSource {
  const root = join(repoRoot, 'dashboard');
  assertSourceDirectory(root, 'dashboard/');

  const files: DashboardFile[] = [];
  let bytes = 0;
  const stack: string[] = [''];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    const abs = rel === '' ? root : join(root, rel);
    const entries = readdirSync(abs, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : join(rel, entry.name);
      const childAbs = join(root, childRel);
      const stat = lstatSync(childAbs);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `dashboard/${childRel} is a symbolic link; source links are refused`,
        );
      }
      if (stat.isDirectory()) {
        if (entry.name.startsWith('.')) {
          throw new Error(
            `dashboard/${childRel} is a dot-directory, which the dossier refuses`,
          );
        }
        if (!PLAIN_NAME.test(entry.name)) {
          throw new Error(
            `dashboard/${childRel}: a directory name is letters, digits and . _ -, 1 to 128 characters`,
          );
        }
        stack.push(childRel);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`dashboard/${childRel} is neither a file nor a directory`);
      }
      if (entry.name.startsWith('.')) continue;
      if (!PLAIN_NAME.test(entry.name)) {
        throw new Error(
          `dashboard/${childRel}: a file name is letters, digits and . _ -, 1 to 128 characters`,
        );
      }
      files.push({ rel: childRel, abs: childAbs, size: stat.size });
      bytes += stat.size;
      if (files.length > DASHBOARD_MAX_FILES) {
        throw new Error(
          `dashboard/ holds more than ${DASHBOARD_MAX_FILES} files`,
        );
      }
      if (bytes > DASHBOARD_MAX_BYTES) {
        throw new Error(
          `dashboard/ files come to more than ${DASHBOARD_MAX_BYTES} bytes`,
        );
      }
    }
  }
  files.sort((left, right) =>
    left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0,
  );
  if (!files.some((file) => file.rel === 'index.html')) {
    throw new Error('dashboard/index.html is missing');
  }
  if (!files.some((file) => file.rel.endsWith('.css'))) {
    throw new Error('dashboard/ holds no .css stylesheet');
  }
  if (!files.some((file) => file.rel.endsWith('.js'))) {
    throw new Error('dashboard/ holds no .js script');
  }
  return { files, bytes };
}

export function writeDashboard(
  source: DashboardSource,
  outputDir: string,
): void {
  const root = join(outputDir, 'dashboard');
  mkdirSync(root, { recursive: true });
  for (const file of source.files) {
    const destination = join(root, file.rel);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(file.abs, destination);
  }
}

interface Screenshot {
  readonly name: string;
  readonly bytes: Buffer;
}

function pngDimensions(bytes: Buffer, label: string): { width: number; height: number } {
  if (
    bytes.length < 33 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    throw new Error(`${label} is not a PNG`);
  }
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error(`${label} does not open with a 13-byte IHDR chunk`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) {
    throw new Error(`${label} has a zero dimension`);
  }
  const end = bytes.length - 12;
  if (
    end < 8 ||
    bytes.readUInt32BE(end) !== 0 ||
    bytes.toString('ascii', end + 4, end + 8) !== 'IEND'
  ) {
    throw new Error(`${label} has no terminal IEND chunk; it is truncated`);
  }
  return { width, height };
}

/**
 * Load exactly the three repository screenshots. No image is generated,
 * resized or otherwise fabricated here.
 */
export function loadScreenshots(repoRoot: string): readonly Screenshot[] {
  const root = join(repoRoot, 'screenshots');
  assertSourceDirectory(root, 'screenshots/');
  const visible = readdirSync(root)
    .filter((name) => !name.startsWith('.'))
    .sort();
  const expected = [...SCREENSHOT_NAMES];
  if (
    visible.length !== expected.length ||
    visible.some((name, index) => name !== expected[index])
  ) {
    throw new Error(
      `screenshots/ must hold exactly ${expected.join(', ')}; found ` +
        `${visible.length === 0 ? 'none' : visible.join(', ')}. ` +
        'Use --prepare, capture the three real screenshots, then copy them into screenshots/.',
    );
  }

  return Object.freeze(
    expected.map((name) => {
      const bytes = readSourceFile(
        join(root, name),
        `screenshots/${name}`,
        SCREENSHOT_MAX_BYTES,
      );
      const { width, height } = pngDimensions(bytes, `screenshots/${name}`);
      const longSide = Math.max(width, height);
      const shortSide = Math.min(width, height);
      if (longSide > 1440 || shortSide < 800) {
        throw new Error(
          `screenshots/${name} is ${width}x${height}; the gate requires a ` +
            'long side at most 1440 and a short side at least 800',
        );
      }
      return { name, bytes };
    }),
  );
}

export function writeScreenshots(
  screenshots: readonly Screenshot[],
  outputDir: string,
): void {
  const root = join(outputDir, 'screenshots');
  mkdirSync(root, { recursive: true });
  for (const screenshot of screenshots) {
    writeFileSync(join(root, screenshot.name), screenshot.bytes);
  }
}

/**
 * Accept a missing directory or an existing empty directory. A non-empty
 * output is refused rather than mixed with or deleted; the program never
 * removes files.
 */
export function ensureFreshOutputDir(outputDir: string): void {
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstatSync(outputDir);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === 'ENOENT') {
      mkdirSync(outputDir, { recursive: true });
      return;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`output ${outputDir} is a symbolic link; refusing to write`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`output ${outputDir} exists and is not a directory`);
  }
  const entries = readdirSync(outputDir);
  if (entries.length > 0) {
    throw new Error(
      `output ${outputDir} is not empty; refusing to mix runs. No files were ` +
        'deleted. Choose a fresh output directory.',
    );
  }
}

export function serializeBoard(rows: readonly BoardRow[]): string {
  const text = `${JSON.stringify({ rows }, null, 2)}\n`;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > BOARD_MAX_BYTES) {
    throw new Error(
      `board.json is ${bytes} bytes, over the ${BOARD_MAX_BYTES}-byte cap`,
    );
  }
  return text;
}

export interface RunOptions {
  readonly argv?: readonly string[];
  readonly env?: Env;
  readonly repoRoot?: string;
  /** Test seam only; production uses the real dynamic import. */
  readonly farmLoader?: ModuleLoader;
  /** Test seam only; production uses the audited vendor dynamic import. */
  readonly dossierLoader?: ModuleLoader;
}

function defaultRepoRoot(): string {
  return fileURLToPath(new URL('.', import.meta.url));
}

const USAGE =
  'usage: node main.ts [--input <snapshot.json|directory>] [--output <directory>] [--prepare]\n' +
  '  --prepare  write board.json, data.js and dashboard/ only; skip screenshots/ and dossier.json\n';

/** Run one entry build. Returns a process exit code instead of exiting. */
export async function runCli(options: RunOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? defaultRepoRoot();

  try {
    const cli = parseCli(argv);
    if (cli.help) {
      process.stdout.write(USAGE);
      return 0;
    }

    const inputPath = resolveInputPath(cli.input, env);
    const outputPath = resolveOutputPath(cli.output, env);
    const report: SnapshotReport = adaptSnapshot(readSnapshot(inputPath));
    const benchmark = benchmarkValuation(report);
    const farm = await loadFarmPlanner(options.farmLoader);
    const data: EntryData = assemble(report, benchmark, farm);
    const board = buildBoard(data, report);
    const boardText = serializeBoard(board);

    // Preflight every source and optional module before creating output, so a
    // pending component fails without leaving a half-written run.
    const dashboard = scanDashboard(repoRoot);
    const screenshots = cli.prepare ? undefined : loadScreenshots(repoRoot);
    const buildDossier = cli.prepare
      ? undefined
      : await loadDossierBuilder(options.dossierLoader);

    ensureFreshOutputDir(outputPath);
    writeFileSync(join(outputPath, 'board.json'), boardText);
    writeFileSync(join(outputPath, 'data.js'), dataScript(data));
    writeDashboard(dashboard, outputPath);

    if (cli.prepare) {
      process.stdout.write(
        `token radar: prepared ${data.rows.length} rows from ` +
          `${data.counts.protocols} protocols (${data.counts.watchlist}/` +
          `${data.counts.watchlist} watchlist covered); wrote board.json, data.js ` +
          `and dashboard/ (${dashboard.files.length} files). Screenshots and ` +
          'dossier.json were intentionally skipped; capture the three real ' +
          'screenshots, then run the full build into a fresh output.\n',
      );
      return 0;
    }

    if (screenshots === undefined || buildDossier === undefined) {
      throw new Error('full build lost its screenshots or dossier builder');
    }
    writeScreenshots(screenshots, outputPath);
    const dossier = buildDossier(outputPath, {
      text_max_bytes: TEXT_MAX_BYTES,
      screenshots: {
        max: SCREENSHOT_MAX,
        max_bytes: SCREENSHOT_MAX_BYTES,
      },
      dashboard: {
        max_files: DASHBOARD_MAX_FILES,
        max_bytes: DASHBOARD_MAX_BYTES,
      },
    });
    if (!(dossier instanceof Uint8Array)) {
      throw new Error('buildDossier did not return dossier bytes');
    }
    if (dossier.length > DOSSIER_GATE_MAX_BYTES) {
      throw new Error(
        `dossier.json is ${dossier.length} bytes, over the ` +
          `${DOSSIER_GATE_MAX_BYTES}-byte gate cap`,
      );
    }
    writeFileSync(join(outputPath, 'dossier.json'), dossier);

    process.stdout.write(
      `token radar: ${data.counts.protocols} protocols, ` +
        `${data.counts.watchlist}/${data.counts.watchlist} watchlist covered, ` +
        `${data.rows.length} ranked rows; wrote board.json, data.js, dashboard/ ` +
        `(${dashboard.files.length} files), screenshots/ (${screenshots.length}) ` +
        `and dossier.json (${dossier.length} bytes) to ${outputPath}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`token radar: ${message}\n`);
    return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  void runCli().then((code) => {
    process.exitCode = code;
  });
}
