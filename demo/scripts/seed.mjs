#!/usr/bin/env node
// Inserts (or updates) one prospect, which is the whole of "adding a client to
// the campaign": a row here is a working demo link, immediately.
//
// Talks to Supabase over PostgREST with the service role key, the same
// credential the app uses, so there is nothing extra to install.
//
// Usage:
//   node scripts/seed.mjs                      # the built-in test prospect
//   node scripts/seed.mjs \
//     --slug rosebank-family-dental \
//     --name "Rosebank Family Dental" \
//     --suburb "Rosebank, Johannesburg" \
//     --services "general dentistry,implants,orthodontics" \
//     --hours "Mon–Fri 08:00–17:00, Sat 08:00–13:00"
//
//   node scripts/seed.mjs --slug rosebank-family-dental --reset
//     Re-arms a link whose demo has already been used. For your own testing —
//     a prospect gets one conversation.
//
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment, or
// from .env.local if it exists.

import { existsSync } from 'node:fs';

const TEST_PROSPECT = {
  slug: 'rosebank-family-dental',
  practice_name: 'Rosebank Family Dental',
  suburb: 'Rosebank, Johannesburg',
  services: ['general dentistry', 'implants', 'orthodontics'],
  hours: 'Mon–Fri 08:00–17:00, Sat 08:00–13:00',
};

const USAGE = `Add or update one prospect — a row here is a working demo link.

  node scripts/seed.mjs                       seed the built-in test prospect
  node scripts/seed.mjs --slug <slug> --name "<practice>" [options]
  node scripts/seed.mjs --slug <slug> --reset clear demo_used_at (testing only)

Options:
  --slug      lowercase letters, digits and hyphens; becomes /demo/<slug>
  --name      practice name, required for a new prospect
  --suburb    e.g. "Rosebank, Johannesburg"
  --services  comma separated, e.g. "general dentistry,implants"
  --hours     free text, e.g. "Mon-Fri 08:00-17:00, Sat 08:00-13:00"

Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment or
.env.local. Set DEMO_BASE_URL to have the printed link use your real domain.`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function loadEnvLocal() {
  if (!existsSync('.env.local')) return;
  // Node 22 parses and applies the file for us.
  process.loadEnvFile('.env.local');
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env.local and fill it in.`);
    process.exit(1);
  }
  return value;
}

async function rest(path, init) {
  const url = `${requireEnv('SUPABASE_URL').replace(/\/$/, '')}/rest/v1/${path}`;
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const response = await fetch(url, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...init?.headers,
    },
  });

  const text = await response.text();
  if (!response.ok) {
    console.error(`Supabase returned ${response.status}: ${text}`);
    process.exit(1);
  }
  return text ? JSON.parse(text) : null;
}

async function main() {
  loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return;
  }

  const slug = typeof args.slug === 'string' ? args.slug : TEST_PROSPECT.slug;

  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    console.error(`Invalid slug "${slug}". Lowercase letters, digits and hyphens only.`);
    process.exit(1);
  }

  if (args.reset) {
    const rows = await rest(`prospects?slug=eq.${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      body: JSON.stringify({ demo_used_at: null }),
    });
    if (!rows?.length) {
      console.error(`No prospect with slug "${slug}".`);
      process.exit(1);
    }
    console.log(`Re-armed ${slug}. The link will offer a live call again.`);
    return;
  }

  const record = {
    slug,
    practice_name:
      typeof args.name === 'string'
        ? args.name
        : slug === TEST_PROSPECT.slug
          ? TEST_PROSPECT.practice_name
          : null,
    suburb: typeof args.suburb === 'string' ? args.suburb : slug === TEST_PROSPECT.slug ? TEST_PROSPECT.suburb : null,
    services:
      typeof args.services === 'string'
        ? args.services
            .split(',')
            .map((service) => service.trim())
            .filter(Boolean)
        : slug === TEST_PROSPECT.slug
          ? TEST_PROSPECT.services
          : null,
    hours: typeof args.hours === 'string' ? args.hours : slug === TEST_PROSPECT.slug ? TEST_PROSPECT.hours : null,
  };

  if (!record.practice_name) {
    console.error('--name is required for a new prospect. Run with --help for an example.');
    process.exit(1);
  }

  // Upsert on slug, so re-running with corrected details fixes the row rather
  // than failing on the unique index. `demo_used_at` is deliberately not in
  // the payload: re-seeding must not silently hand out a second conversation.
  const [row] = await rest('prospects?on_conflict=slug', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(record),
  });

  const base = process.env.DEMO_BASE_URL?.replace(/\/$/, '') ?? 'http://localhost:3000';
  console.log(`Seeded ${row.practice_name}`);
  console.log(`  ${base}/demo/${row.slug}`);
  if (row.demo_used_at) {
    console.log(`  Already used at ${row.demo_used_at} — run with --reset to re-arm it.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
