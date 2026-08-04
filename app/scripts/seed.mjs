#!/usr/bin/env node
// Generates the SQL that onboards one client: an organization plus its first
// owner login. Emitting SQL (rather than talking to D1 directly) keeps the
// password hashing local and lets you read exactly what will be written before
// you apply it to production.
//
// Usage:
//   node scripts/seed.mjs \
//     --org "Riverside Dental Studio" \
//     --email owner@riversidedental.co.za \
//     --name "Dr Naledi Dube" \
//     --phone "082 555 0134" \
//     --assistant-id asst_xxx \
//     --phone-number-id pn_xxx \
//     --services "Check-up & Cleaning,Filling,Whitening Consult" \
//     > seed-riverside.sql
//
// Then:
//   npx wrangler d1 execute ctf-app --remote --file seed-riverside.sql

import { webcrypto as crypto } from 'node:crypto';

const ITERATIONS = 210_000;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = 'true';
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2$sha256$${ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

function randomToken(byteLength) {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(byteLength)))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Single-quote escaping for SQL string literals. */
function sql(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

const orgName = args.org;
const email = args.email?.trim().toLowerCase();
const userName = args.name;

if (!orgName) fail('--org is required (the client business name)');
if (!email) fail('--email is required (the first login)');
if (!userName) fail('--name is required (the person who owns the login)');
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(`--email "${email}" is not a valid address`);

const slug = args.slug ? slugify(args.slug) : slugify(orgName);
const timezone = args.timezone ?? 'Africa/Johannesburg';
const services = (args.services ?? '')
  .split(',')
  .map((service) => service.trim())
  .filter(Boolean);

// A generated temporary password is the default: it is written to stderr (not
// into the SQL file) and the account is flagged to force a change at first use.
const generatedPassword = args.password ?? randomToken(12);
const mustChange = args.password ? 0 : 1;

const orgId = `org_${randomToken(12)}`;
const userId = `usr_${randomToken(12)}`;
const now = Date.now();
const passwordHash = await hashPassword(generatedPassword);

const statements = [
  `-- Onboarding: ${orgName}`,
  `-- Generated ${new Date(now).toISOString()}`,
  '',
  `INSERT INTO organizations (
  id, name, slug, timezone, services,
  vapi_assistant_id, vapi_phone_number_id, takeover_number, created_at, updated_at
) VALUES (
  ${sql(orgId)}, ${sql(orgName)}, ${sql(slug)}, ${sql(timezone)}, ${sql(JSON.stringify(services))},
  ${sql(args['assistant-id'])}, ${sql(args['phone-number-id'])}, ${sql(args['takeover-number'])}, ${now}, ${now}
);`,
  '',
  `INSERT INTO users (
  id, org_id, email, name, role, phone,
  password_hash, must_change_password, disabled, created_at, updated_at
) VALUES (
  ${sql(userId)}, ${sql(orgId)}, ${sql(email)}, ${sql(userName)}, 'owner', ${sql(args.phone)},
  ${sql(passwordHash)}, ${mustChange}, 0, ${now}, ${now}
);`,
  '',
];

process.stdout.write(`${statements.join('\n')}\n`);

process.stderr.write(
  [
    '',
    `Organization : ${orgName} (${orgId})`,
    `Login        : ${email}`,
    args.password
      ? 'Password     : (the one you supplied)'
      : `Temp password: ${generatedPassword}   <- share over a secure channel; it must be changed at first sign-in`,
    '',
    'Apply with:',
    '  npx wrangler d1 execute ctf-app --remote --file <the file you piped this into>',
    '',
  ].join('\n'),
);
