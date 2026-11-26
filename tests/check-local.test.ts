/**
 * Red/green tests for the independent local release gate.
 *
 * Every fixture here is synthetic: a made-up snapshot of 130 protocols, a
 * made-up 130-row board, made-up dashboard source, and generated PNGs. Nothing
 * in this file reads the official snapshot, the kit, or vendor code. The tests
 * assert the checker's documented file-gate behaviour, not sealed-grader
 * parity and not anything about a rendered page.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';

import {
  BOARD_MAX_BYTES,
  DOSSIER_MAX_BYTES,
  DOSSIER_TEXT_MAX_BYTES,
  SCREENSHOT_NAMES,
  compareReruns,
  inspectOutput,
  loadSnapshot,
  runCli,
} from '../tools/check-local.ts';

const sha256 = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------- PNG fixture

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/** A whole, decodable 8-bit RGBA PNG of solid transparent pixels. */
function makePng(width: number, height: number): Buffer {
  const row = Buffer.alloc(1 + width * 4); // filter byte 0, then RGBA zeros
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- fixtures

const AS_OF = '2026-11-14';
const SOURCE = 'DefiLlama https://api.llama.fi/protocols, fetched 2026-11-14T01:18:33.201Z';
const FLOOR = 50_000_000;

interface Fixture {
  root: string;
  snapshotPath: string;
  snapshotSha: string;
  outA: string;
  outB: string;
}

function protocol(i: number): Record<string, unknown> {
  return {
    slug: `synthetic-${String(i).padStart(3, '0')}`,
    name: `Synthetic Protocol ${i}`,
    category: null,
    chains: ['Ethereum'],
    tvl_usd: 100_000_000 + i,
    change_7d: 1.5,
    mcap_usd: null,
    listed_at: '2025-01-01',
    gecko_id: null,
    symbol: null,
  };
}

function boardRow(i: number, protocolI = i): Record<string, unknown> {
  return {
    slug: `synthetic-${String(protocolI).padStart(3, '0')}`,
    name: `Synthetic Protocol ${protocolI}`,
    rank: i + 1,
    implied_value_usd: 5_000_000_000 - i * 1_000_000,
    farm_steps: [
      'Bridge the asset into the protocol and deposit it.',
      'Track the position weekly and claim any rewards promptly.',
      'Exit in two tranches after the token event is confirmed.',
    ],
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out.sort();
}

function dashboardHead(dir: string): string {
  const files = walk(join(dir, 'dashboard'))
    .map((path) => ({ path: relative(join(dir, 'dashboard'), path).replaceAll('\\', '/'), size: readFileSync(path).length }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const total = files.reduce((sum, file) => sum + file.size, 0);
  return [
    '## Dashboard',
    '',
    `Files: ${files.length} (${total} bytes)`,
    ...files.map((file) => `- ${file.path} (${file.size} bytes)`),
    '',
    '## Source',
    '',
    '',
  ].join('\n');
}

function makeDossier(out: string): Record<string, unknown> {
  const images = SCREENSHOT_NAMES.map((name) => {
    const bytes = readFileSync(join(out, 'screenshots', name));
    return {
      name,
      media_type: 'image/png',
      sha256: sha256(bytes),
      base64: bytes.toString('base64'),
    };
  });
  const head = dashboardHead(out);
  const text = `${head}### app.js\n\n1 byte, 1 line\n\n\`\`\`js\nx\n\`\`\`\n\n`;
  return { schema: 'makefun/dossier/v1', cover: 0, text, images };
}

function buildOutput(out: string): void {
  mkdirSync(join(out, 'dashboard'), { recursive: true });
  mkdirSync(join(out, 'screenshots'), { recursive: true });

  writeFileSync(
    join(out, 'dashboard', 'index.html'),
    '<!doctype html><html><body><h1>Radar</h1><a href="./detail.html">Detail</a><script src="./app.js"></script></body></html>\n',
  );
  writeFileSync(join(out, 'dashboard', 'detail.html'), '<!doctype html><html><body><p>Detail</p></body></html>\n');
  writeFileSync(join(out, 'dashboard', 'app.css'), 'body { margin: 0; font-family: sans-serif; }\n');
  writeFileSync(join(out, 'dashboard', 'app.js'), "import './data.js';\nconsole.log('radar');\n");
  writeFileSync(join(out, 'dashboard', 'data.js'), 'export const rows = [];\n');

  for (const [index, name] of SCREENSHOT_NAMES.entries()) {
    writeFileSync(join(out, 'screenshots', name), makePng(800, 1000 + index));
  }

  writeJson(join(out, 'board.json'), {
    rows: Array.from({ length: 130 }, (_, i) => boardRow(i)),
  });
  writeJson(join(out, 'dossier.json'), makeDossier(out));
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'tr-local-gate-'));
  const snapshotPath = join(root, 'snapshot.json');
  const snapshotBytes = Buffer.from(
    JSON.stringify({
      as_of: AS_OF,
      source: SOURCE,
      floor_usd: FLOOR,
      protocols: Array.from({ length: 130 }, (_, i) => protocol(i)),
      watchlist: ['synthetic-000', 'synthetic-001', 'synthetic-002'],
    }),
    'utf8',
  );
  writeFileSync(snapshotPath, snapshotBytes);
  const snapshotSha = sha256(snapshotBytes);

  const outA = join(root, 'out-a');
  const outB = join(root, 'out-b');
  buildOutput(outA);
  buildOutput(outB);
  return { root, snapshotPath, snapshotSha, outA, outB };
}

function withFixture(fn: (fixture: Fixture, snapshot: ReturnType<typeof loadSnapshot>) => void): void {
  const fixture = makeFixture();
  try {
    fn(fixture, loadSnapshot(fixture.snapshotPath, fixture.snapshotSha));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function check(report: ReturnType<typeof inspectOutput>, id: string) {
  const found = report.checks.find((entry) => entry.id === id);
  assert.ok(found, `missing check ${id}`);
  return found;
}

function readBoard(out: string): { rows: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(join(out, 'board.json'), 'utf8'));
}

function writeBoard(out: string, board: { rows: Record<string, unknown>[] }): void {
  writeJson(join(out, 'board.json'), board);
}

function assertFails(report: ReturnType<typeof inspectOutput>, id: string, pattern: RegExp): void {
  const result = check(report, id);
  assert.equal(result.status, 'fail', `${id} should fail: ${result.detail}`);
  assert.match(result.detail, pattern);
}

// ---------------------------------------------------------------- snapshot

test('loadSnapshot verifies the pinned digest and derives the watchlist', () => {
  withFixture((fixture, snapshot) => {
    assert.equal(snapshot.watchlist.length, 3);
    assert.ok(snapshot.protocols.has('synthetic-129'));
    assert.equal(snapshot.sha256, fixture.snapshotSha);
  });
});

test('loadSnapshot rejects a digest mismatch without repairing anything', () => {
  withFixture((fixture) => {
    assert.throws(
      () => loadSnapshot(fixture.snapshotPath, '0'.repeat(64)),
      /sha256/i,
    );
  });
});

test('loadSnapshot rejects a watchlist slug that names no protocol', () => {
  const root = mkdtempSync(join(tmpdir(), 'tr-local-gate-'));
  try {
    const path = join(root, 'snapshot.json');
    const bytes = Buffer.from(
      JSON.stringify({
        as_of: AS_OF,
        source: SOURCE,
        floor_usd: FLOOR,
        protocols: [protocol(0)],
        watchlist: ['missing-slug'],
      }),
      'utf8',
    );
    writeFileSync(path, bytes);
    assert.throws(() => loadSnapshot(path, sha256(bytes)), /watchlist/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- valid output

test('a synthetic valid output passes every local gate row', () => {
  withFixture((fixture, snapshot) => {
    const report = inspectOutput(fixture.outA, snapshot);
    assert.deepEqual(
      report.checks.filter((entry) => entry.status === 'fail').map((entry) => entry.id),
      [],
    );
    for (const id of [
      'dashboard_files',
      'board_file',
      'sorted_by_value',
      'coverage',
      'farm_steps',
      'screenshots',
      'dossier_matches_local',
    ]) {
      assert.equal(check(report, id).status, 'pass', `${id}: ${check(report, id).detail}`);
    }
  });
});

// ---------------------------------------------------------------- board

test('board rank gaps fail sorted_by_value', () => {
  withFixture((fixture, snapshot) => {
    const board = readBoard(fixture.outA);
    board.rows[4]!.rank = 99;
    writeBoard(fixture.outA, board);
    assertFails(inspectOutput(fixture.outA, snapshot), 'sorted_by_value', /rank/i);
  });
});

test('implied value rising with rank fails sorted_by_value', () => {
  withFixture((fixture, snapshot) => {
    const board = readBoard(fixture.outA);
    board.rows[4]!.implied_value_usd = 9_000_000_000;
    writeBoard(fixture.outA, board);
    assertFails(inspectOutput(fixture.outA, snapshot), 'sorted_by_value', /does not rise|non-increasing|descending/i);
  });
});

test('all implied values equal fails sorted_by_value', () => {
  withFixture((fixture, snapshot) => {
    const board = readBoard(fixture.outA);
    for (const row of board.rows) row.implied_value_usd = 1_000_000;
    writeBoard(fixture.outA, board);
    assertFails(inspectOutput(fixture.outA, snapshot), 'sorted_by_value', /same|equal|ranks nothing/i);
  });
});

test('impossible implied values fail board_file', () => {
  withFixture((fixture, snapshot) => {
    const board = readBoard(fixture.outA);
    board.rows[0]!.implied_value_usd = 100_000_000_000_001;
    writeBoard(fixture.outA, board);
    assertFails(inspectOutput(fixture.outA, snapshot), 'board_file', /implied_value_usd/i);
  });
});

test('an invented slug fails board_file', () => {
  withFixture((fixture, snapshot) => {
    const board = readBoard(fixture.outA);
    board.rows[0]!.slug = 'not-in-the-snapshot';
    writeBoard(fixture.outA, board);
    assertFails(inspectOutput(fixture.outA, snapshot), 'board_file', /not in the snapshot|unknown|invented/i);
  });
});

test('a missing watchlist slug fails coverage', () => {
  withFixture((fixture, snapshot) => {
    const board = readBoard(fixture.outA);
    board.rows = board.rows.filter((row) => row.slug !== 'synthetic-002');
    board.rows.forEach((row, i) => {
      row.rank = i + 1;
    });
    writeBoard(fixture.outA, board);
    assertFails(inspectOutput(fixture.outA, snapshot), 'coverage', /watchlist|coverage/i);
  });
});

test('short farm steps fail farm_steps', () => {
  withFixture((fixture, snapshot) => {
    const board = readBoard(fixture.outA);
    (board.rows[0]!.farm_steps as string[])[0] = 'too short';
    writeBoard(fixture.outA, board);
    assertFails(inspectOutput(fixture.outA, snapshot), 'farm_steps', /20|characters/i);
  });
});

test('fewer than 100 board rows fail board_file', () => {
  withFixture((fixture, snapshot) => {
    writeBoard(fixture.outA, { rows: Array.from({ length: 99 }, (_, i) => boardRow(i)) });
    assertFails(inspectOutput(fixture.outA, snapshot), 'board_file', /100|4,000|4000/i);
  });
});

test('an oversized board fails before parsing', () => {
  withFixture((fixture, snapshot) => {
    writeFileSync(join(fixture.outA, 'board.json'), Buffer.alloc(BOARD_MAX_BYTES + 1, 0x20));
    assertFails(inspectOutput(fixture.outA, snapshot), 'board_file', /bytes|size/i);
  });
});

// ---------------------------------------------------------------- dashboard

test('a dashboard without a stylesheet fails dashboard_files', () => {
  withFixture((fixture, snapshot) => {
    rmSync(join(fixture.outA, 'dashboard', 'app.css'));
    assertFails(inspectOutput(fixture.outA, snapshot), 'dashboard_files', /\.css|stylesheet/i);
  });
});

test('an http address in an HTML attribute fails dashboard_files', () => {
  withFixture((fixture, snapshot) => {
    writeFileSync(
      join(fixture.outA, 'dashboard', 'index.html'),
      '<!doctype html><html><body><a href="https://example.com/">x</a></body></html>\n',
    );
    assertFails(inspectOutput(fixture.outA, snapshot), 'dashboard_files', /external|http/i);
  });
});

test('visible text and comments may carry URLs', () => {
  withFixture((fixture, snapshot) => {
    writeFileSync(
      join(fixture.outA, 'dashboard', 'index.html'),
      '<!doctype html><html><body><!-- https://example.com/comment --><p>Read https://example.com/notes</p></body></html>\n',
    );
    const result = check(inspectOutput(fixture.outA, snapshot), 'dashboard_files');
    assert.equal(result.status, 'pass', result.detail);
  });
});

test('an http import in JavaScript fails dashboard_files, but a comment URL does not', () => {
  withFixture((fixture, snapshot) => {
    writeFileSync(
      join(fixture.outA, 'dashboard', 'app.js'),
      "// see https://example.com/docs\nimport './data.js';\n",
    );
    assert.equal(check(inspectOutput(fixture.outA, snapshot), 'dashboard_files').status, 'pass');
    writeFileSync(
      join(fixture.outA, 'dashboard', 'app.js'),
      "import 'https://example.com/x.js';\n",
    );
    assertFails(inspectOutput(fixture.outA, snapshot), 'dashboard_files', /external|http/i);
  });
});

test('an http URL in a CSS body fails dashboard_files, but a CSS comment URL does not', () => {
  withFixture((fixture, snapshot) => {
    writeFileSync(join(fixture.outA, 'dashboard', 'app.css'), '/* https://example.com */\nbody { color: black; }\n');
    assert.equal(check(inspectOutput(fixture.outA, snapshot), 'dashboard_files').status, 'pass');
    writeFileSync(join(fixture.outA, 'dashboard', 'app.css'), 'body { background: url(https://example.com/x.png); }\n');
    assertFails(inspectOutput(fixture.outA, snapshot), 'dashboard_files', /CSS|external|http/i);
  });
});

// ---------------------------------------------------------------- screenshots

test('a short screenshot side fails screenshots', () => {
  withFixture((fixture, snapshot) => {
    writeFileSync(join(fixture.outA, 'screenshots', SCREENSHOT_NAMES[0]!), makePng(799, 1000));
    assertFails(inspectOutput(fixture.outA, snapshot), 'screenshots', /800|short side/i);
  });
});

test('a screenshot past 512 KiB fails screenshots', () => {
  withFixture((fixture, snapshot) => {
    writeFileSync(join(fixture.outA, 'screenshots', SCREENSHOT_NAMES[0]!), Buffer.alloc(512 * 1024 + 1, 0));
    assertFails(inspectOutput(fixture.outA, snapshot), 'screenshots', /512|bytes|size/i);
  });
});

test('a truncated PNG fails screenshots', () => {
  withFixture((fixture, snapshot) => {
    const bytes = readFileSync(join(fixture.outA, 'screenshots', SCREENSHOT_NAMES[0]!));
    writeFileSync(join(fixture.outA, 'screenshots', SCREENSHOT_NAMES[0]!), bytes.subarray(0, bytes.length - 12));
    assertFails(inspectOutput(fixture.outA, snapshot), 'screenshots', /IEND|whole|PNG/i);
  });
});

// ---------------------------------------------------------------- dossier

test('a dossier image whose bytes disagree fails dossier_matches_local', () => {
  withFixture((fixture, snapshot) => {
    const dossier = JSON.parse(readFileSync(join(fixture.outA, 'dossier.json'), 'utf8'));
    dossier.images[0].base64 = Buffer.from('not the screenshot').toString('base64');
    writeFileSync(join(fixture.outA, 'dossier.json'), JSON.stringify(dossier));
    assertFails(inspectOutput(fixture.outA, snapshot), 'dossier_matches_local', /bytes|base64/i);
  });
});

test('a dossier text past 65,536 bytes fails dossier_matches_local', () => {
  withFixture((fixture, snapshot) => {
    const dossier = JSON.parse(readFileSync(join(fixture.outA, 'dossier.json'), 'utf8'));
    dossier.text = `${dossier.text}${'x'.repeat(DOSSIER_TEXT_MAX_BYTES)}`;
    writeFileSync(join(fixture.outA, 'dossier.json'), JSON.stringify(dossier));
    assertFails(inspectOutput(fixture.outA, snapshot), 'dossier_matches_local', /65,?536|text/i);
  });
});

test('a dossier past 1.5 MiB fails dossier_matches_local', () => {
  withFixture((fixture, snapshot) => {
    writeFileSync(join(fixture.outA, 'dossier.json'), Buffer.alloc(DOSSIER_MAX_BYTES + 1, 0x20));
    assertFails(inspectOutput(fixture.outA, snapshot), 'dossier_matches_local', /1\.5|bytes|size/i);
  });
});

// ---------------------------------------------------------------- reruns

test('two byte-identical runs compare identical', () => {
  withFixture((fixture) => {
    const result = compareReruns(fixture.outA, fixture.outB);
    assert.equal(result.status, 'pass', result.detail);
  });
});

test('a changed byte in one run fails the rerun comparison', () => {
  withFixture((fixture) => {
    writeFileSync(join(fixture.outA, 'dashboard', 'data.js'), 'export const rows = [1];\n');
    const result = compareReruns(fixture.outA, fixture.outB);
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /differ|sha256/i);
  });
});

test('a file present in only one run fails the rerun comparison', () => {
  withFixture((fixture) => {
    writeFileSync(join(fixture.outB, 'extra.txt'), 'extra\n');
    const result = compareReruns(fixture.outA, fixture.outB);
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /only|missing|extra/i);
  });
});

test('a symbolic link in either tree is refused', (t) => {
  withFixture((fixture) => {
    try {
      symlinkSync(join(fixture.outB, 'board.json'), join(fixture.outA, 'linked-board.json'));
    } catch (error) {
      t.skip(`symlink creation is not permitted here: ${(error as Error).message}`);
      return;
    }
    const result = compareReruns(fixture.outA, fixture.outB);
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /symbolic|link|reparse/i);
  });
});

// ---------------------------------------------------------------- CLI

test('the CLI exits 0 for two valid identical runs and 2 for bad usage', () => {
  withFixture((fixture) => {
    const previous = process.env.TOKEN_RADAR_SNAPSHOT_SHA256;
    process.env.TOKEN_RADAR_SNAPSHOT_SHA256 = fixture.snapshotSha;
    try {
      assert.equal(runCli([fixture.snapshotPath, fixture.outA, fixture.outB]), 0);
      assert.equal(runCli([fixture.snapshotPath, fixture.outA]), 2);
    } finally {
      if (previous === undefined) delete process.env.TOKEN_RADAR_SNAPSHOT_SHA256;
      else process.env.TOKEN_RADAR_SNAPSHOT_SHA256 = previous;
    }
  });
});
