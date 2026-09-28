#!/usr/bin/env node
// Backup restore test for the dashboard's database (Cloudflare D1).
//
//   npm run db:backup-test            # the live database
//   npm run db:backup-test -- --keep  # and keep the backup file afterwards
//   npm run db:backup-test -- --local # the `wrangler dev` database, to try it out
//
// A backup is only worth something if it restores, so this proves it end to
// end without going near the live data:
//
//   1. exports the whole database to a .sql file (`wrangler d1 export`),
//   2. restores that file into a brand new, throwaway local database,
//   3. counts the rows of every table in both, and says whether they match.
//
// The live database is only ever read. The throwaway copy and the export are
// written to the system's temp folder and deleted at the end unless --keep is
// given. They hold everything, password hashes included, so a kept file
// belongs somewhere private.
//
// Separately from this, Cloudflare keeps D1's own point-in-time history (Time
// Travel): the database can be rewound to any minute in the retention window
// with `wrangler d1 time-travel restore`. This test does not touch that.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DB = 'ctf-app';
const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const keep = args.has('--keep');
const source = args.has('--local') ? '--local' : '--remote';
const isWindows = process.platform === 'win32';

/** Runs wrangler and returns stdout, or throws with what it printed. */
function wrangler(argv) {
  // On Windows npx is a .cmd file, which needs a shell, and a shell needs
  // arguments with spaces in them quoted.
  const shellSafe = isWindows ? argv.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : argv;
  const result = spawnSync('npx', ['wrangler', ...shellSafe], {
    cwd: APP_ROOT,
    encoding: 'utf8',
    shell: isWindows,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    // Wrangler writes some errors to stdout and some to stderr; show both,
    // without the proxy notice it prints on every run.
    const said = `${result.stdout}\n${result.stderr}`
      .split('\n')
      .filter((line) => line.trim() && !/Proxy environment variables/.test(line))
      .join('\n');
    throw new Error(`wrangler ${argv.slice(0, 2).join(' ')} failed:\n${said}`);
  }
  return result.stdout;
}

/** The rows of a `wrangler d1 execute --json` answer. */
function query(where, sql) {
  const out = wrangler(['d1', 'execute', DB, ...where, '--json', '--command', sql]);
  // Anything wrangler prints before the JSON (a proxy notice, say) is skipped.
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0]?.results ?? [];
}

function tables(where) {
  return query(
    where,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  ).map((row) => row.name);
}

/** Row counts, as one row with a column per table: D1 caps UNION chains. */
function counts(where, names) {
  const sql = `SELECT ${names.map((name) => `(SELECT COUNT(*) FROM "${name}") AS "${name}"`).join(', ')}`;
  const row = query(where, sql)[0] ?? {};
  return Object.fromEntries(names.map((name) => [name, Number(row[name])]));
}

const work = mkdtempSync(join(tmpdir(), 'ctf-app-restore-test-'));
const backupFile = join(work, 'ctf-app-backup.sql');
const restoreDir = join(work, 'restored-database');
let failed = false;

try {
  console.log(`\nBackup restore test: ${DB} (${source === '--remote' ? 'live database' : 'local dev database'})\n`);

  const names = tables([source]);
  if (names.length === 0) throw new Error('The database has no tables to back up.');

  // Counted before and after the export: a table written to in between (a
  // sign-in, a webhook) is then checked against that range rather than
  // reported as a false failure.
  const before = counts([source], names);
  console.log('  1. Exporting a full backup ...');
  wrangler(['d1', 'export', DB, source, '--output', backupFile, '--skip-confirmation']);
  const after = counts([source], names);
  console.log(`     ${(statSync(backupFile).size / 1024).toFixed(0)} KB, ${names.length} tables`);

  console.log('  2. Restoring it into a new, empty database on this computer ...');
  wrangler(['d1', 'execute', DB, '--local', '--persist-to', restoreDir, '--file', backupFile, '--yes']);

  console.log('  3. Comparing every table ...\n');
  const restoredNames = tables(['--local', '--persist-to', restoreDir]);
  const restored = counts(['--local', '--persist-to', restoreDir], restoredNames);

  const width = Math.max(...names.map((n) => n.length));
  for (const name of names) {
    const low = Math.min(before[name], after[name]);
    const high = Math.max(before[name], after[name]);
    const got = restored[name];
    const ok = got !== undefined && got >= low && got <= high;
    if (!ok) failed = true;
    const expected = low === high ? `${low}` : `${low}-${high}, written to during the export`;
    console.log(`     ${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(width)}  ${got ?? 'missing'} rows (expected ${expected})`);
  }

  console.log(
    failed
      ? '\n  FAILED: the restored copy does not match. The backup cannot be trusted as it is.\n'
      : '\n  PASSED: the backup restores completely.\n',
  );
} catch (error) {
  failed = true;
  console.error(`\n  FAILED: ${error instanceof Error ? error.message : error}\n`);
} finally {
  if (keep) {
    console.log(`  The backup is kept at:\n  ${backupFile}\n`);
    console.log('  It contains every account and call, password hashes included. Keep it private.\n');
  } else {
    rmSync(work, { recursive: true, force: true });
  }
}

process.exit(failed ? 1 : 0);
