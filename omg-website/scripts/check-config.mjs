// Runs before `npm run deploy`: stops a deploy that would fail half-way
// because the one-time setup has not been done. Takes an optional path to the
// config (the tests use that); defaults to this site's wrangler.toml.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isRealId, readDatabaseId } from './config.mjs';

const path = process.argv[2] || fileURLToPath(new URL('../wrangler.toml', import.meta.url));
if (!isRealId(readDatabaseId(readFileSync(path, 'utf8')))) {
  console.error('\nThe database is not set up yet, so this deploy would fail.');
  console.error('Run the one-time setup instead (it deploys at the end):\n\n  npm run setup\n');
  process.exit(1);
}
