// One-time production setup for the OMG site. Safe to run again: every step
// checks what already exists first.
//
//   npm run setup
//
// 1. signs in to Cloudflare if needed
// 2. finds or creates the D1 database and writes its id into wrangler.toml
// 3. creates or updates the tables
// 4. deploys the site
// 5. sets the admin password, if it is not set yet
// 6. checks that the live site answers
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDatabaseId, setDatabaseId } from './config.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOML = join(ROOT, 'wrangler.toml');
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const DATABASE = 'omg-oh-my-glam';
const MIN_PASSWORD = 12;

/**
 * Runs wrangler with this Node, no shell, so it behaves the same on Windows.
 * `capture` collects its output (for JSON); otherwise it talks to the
 * terminal directly, so its own questions and sign-in prompts work.
 */
function wrangler(args, { capture = false, input, env = {} } = {}) {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', ...env },
  });
  if (result.error) stop(`Could not run wrangler: ${result.error.message}`, 'Run `npm install` in this folder first.');
  return result;
}

function step(number, text) {
  console.log(`\n[${number}/6] ${text}`);
}

function stop(message, detail) {
  console.error(`\n✗ ${message}`);
  if (detail) console.error(`  ${detail.trim().split('\n').slice(-4).join('\n  ')}`);
  console.error('\nNothing is lost: fix that and run `npm run setup` again.');
  process.exit(1);
}

function parseJson(result, what) {
  try {
    return JSON.parse(result.stdout.slice(result.stdout.search(/[[{]/)));
  } catch {
    return stop(`Could not read ${what} from wrangler.`, result.stderr || result.stdout || '');
  }
}

function findDatabase() {
  const list = wrangler(['d1', 'list', '--json'], { capture: true });
  if (list.status !== 0) stop('Could not list your D1 databases.', list.stderr || '');
  const found = parseJson(list, 'the database list').find((db) => db.name === DATABASE);
  return found ? found.uuid : null;
}

/** Reads a line from the terminal without showing what is typed. */
function askHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = [...value].slice(0, -1).join('');
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function choosePassword() {
  if (!process.stdin.isTTY) stop('Setting the admin password needs a terminal.', 'Run `npm run setup` in a terminal window.');
  console.log(`Choose the admin page password: at least ${MIN_PASSWORD} characters, not used anywhere else.`);
  console.log('Nothing shows on screen while you type.');
  for (;;) {
    const password = await askHidden('Password: ');
    if ([...password].length < MIN_PASSWORD) {
      console.log(`That is ${[...password].length} characters; it needs at least ${MIN_PASSWORD}.`);
    } else if (password !== password.trim()) {
      console.log('Do not start or end it with a space.');
    } else if ((await askHidden('Type it again: ')) !== password) {
      console.log('The two did not match. Try again.');
    } else {
      return password;
    }
  }
}

// 1. Cloudflare account
step(1, 'Cloudflare sign-in');
const who = wrangler(['whoami'], { capture: true });
if (who.status !== 0 || /not authenticated|not logged in/i.test(`${who.stdout}${who.stderr}`)) {
  console.log('Opening the Cloudflare sign-in page in your browser…');
  if (wrangler(['login']).status !== 0) stop('Cloudflare sign-in did not finish.');
} else {
  console.log('Already signed in.');
}

// 2. The database
step(2, `The "${DATABASE}" database`);
let id = findDatabase();
if (id) {
  console.log(`Found it (${id}).`);
} else {
  console.log('Creating it…');
  if (wrangler(['d1', 'create', DATABASE], { capture: true }).status !== 0) stop('Could not create the database.');
  id = findDatabase();
  if (!id) stop('The database was created but could not be found afterwards.');
  console.log(`Created (${id}).`);
}
const toml = readFileSync(TOML, 'utf8');
if (readDatabaseId(toml) !== id) {
  writeFileSync(TOML, setDatabaseId(toml, id));
  console.log('Saved its id in wrangler.toml. Commit that change, so later deploys use it.');
}

// 3. The tables
step(3, 'Tables');
if (wrangler(['d1', 'migrations', 'apply', DATABASE, '--remote']).status !== 0) stop('Could not create the tables.');

// 4. The site. Wrangler writes the live address to this file.
step(4, 'Deploying the site');
const outDir = mkdtempSync(join(tmpdir(), 'omg-setup-'));
const outFile = join(outDir, 'out.ndjson');
const deployed = wrangler(['deploy'], { env: { WRANGLER_OUTPUT_FILE_PATH: outFile } });
let siteUrl = null;
try {
  for (const line of readFileSync(outFile, 'utf8').split('\n')) {
    const entry = line ? JSON.parse(line) : null;
    if (entry?.type === 'deploy') siteUrl = (entry.targets || []).find((t) => t.startsWith('https://')) || null;
  }
} catch {
  siteUrl = null;
}
rmSync(outDir, { recursive: true, force: true });
if (deployed.status !== 0) stop('The deploy failed. The reason is just above.');
if (siteUrl && !/^https:\/\/[a-z0-9.-]+$/i.test(siteUrl.replace(/\/$/, ''))) siteUrl = null;
siteUrl = siteUrl && siteUrl.replace(/\/$/, '');

// 5. The admin password
step(5, 'Admin password');
const secrets = wrangler(['secret', 'list', '--format', 'json'], { capture: true });
const hasPassword = secrets.status === 0 && parseJson(secrets, 'the secret list').some((s) => s.name === 'ADMIN_PASSWORD');
if (hasPassword) {
  console.log('Already set. To change it later: npx wrangler secret put ADMIN_PASSWORD');
} else {
  const password = await choosePassword();
  if (wrangler(['secret', 'put', 'ADMIN_PASSWORD'], { input: password }).status !== 0) stop('The password was not saved.');
}

// 6. Check that it answers
step(6, 'Checking the live site');
if (!siteUrl) {
  console.log('Deployed. Find its address in the Cloudflare dashboard: Workers & Pages > omg-oh-my-glam.');
} else {
  const month = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 7); // SAST
  let ok = false;
  for (let attempt = 0; attempt < 8 && !ok; attempt += 1) {
    if (attempt) await new Promise((r) => setTimeout(r, 5000));
    try {
      const res = await fetch(`${siteUrl}/api/availability?month=${month}`);
      ok = res.ok && (await res.json()).ok === true;
    } catch {
      ok = false;
    }
  }
  if (ok) console.log(`\n✓ Live at ${siteUrl}`);
  else console.log(`\n! Deployed to ${siteUrl}, but it is not answering yet. New addresses can take a few minutes; open it again shortly.`);
  console.log(`  Admin page: ${siteUrl}/admin/`);
}
console.log("\nTo use OMG's own domain: Cloudflare dashboard > Workers & Pages > omg-oh-my-glam > Settings > Domains & Routes.");
