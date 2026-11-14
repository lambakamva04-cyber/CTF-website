// The database id in wrangler.toml, the pre-deploy check and the setup script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PLACEHOLDER_ID, isRealId, readDatabaseId, setDatabaseId } from '../scripts/config.mjs';

const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const REAL = '2864d4e4-dc2b-4016-8775-6da6f93c0d27';
const FRESH = `name = "omg-oh-my-glam"

[[d1_databases]]
binding = "DB"
database_name = "omg-oh-my-glam"
database_id = "${PLACEHOLDER_ID}"
migrations_dir = "migrations"
`;

test('the committed wrangler.toml has a database id line (placeholder or real)', () => {
  const id = readDatabaseId(readFileSync(fileURLToPath(new URL('../wrangler.toml', import.meta.url)), 'utf8'));
  assert.ok(id === PLACEHOLDER_ID || isRealId(id), `unexpected database_id: ${id}`);
});

test('setDatabaseId writes a real id and changes nothing else', () => {
  assert.equal(readDatabaseId(FRESH), PLACEHOLDER_ID);
  assert.ok(!isRealId(PLACEHOLDER_ID));
  const out = setDatabaseId(FRESH, REAL);
  assert.equal(readDatabaseId(out), REAL);
  assert.equal(out.replace(REAL, PLACEHOLDER_ID), FRESH);
  for (const bad of ['', 'abc', PLACEHOLDER_ID, `${REAL}"\nmain = "evil.js`, null]) {
    assert.throws(() => setDatabaseId(FRESH, bad));
  }
});

test('the pre-deploy check stops a deploy until setup has run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omg-config-'));
  try {
    const fresh = join(dir, 'fresh.toml');
    const done = join(dir, 'done.toml');
    writeFileSync(fresh, FRESH);
    writeFileSync(done, setDatabaseId(FRESH, REAL));
    const before = spawnSync(process.execPath, [script('check-config.mjs'), fresh], { encoding: 'utf8' });
    assert.equal(before.status, 1);
    assert.match(before.stderr, /npm run setup/);
    const after = spawnSync(process.execPath, [script('check-config.mjs'), done], { encoding: 'utf8' });
    assert.equal(after.status, 0, after.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the setup script parses', () => {
  const run = spawnSync(process.execPath, ['--check', script('setup.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});
