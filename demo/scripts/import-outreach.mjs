#!/usr/bin/env node
// Imports the founder's cold-outreach cadence tracker (a CSV export) into the
// `outreach` table, so the admin analytics dashboard reads the same cadence the
// founder keeps by hand.
//
// Each row is matched to a prospect by practice name (case-insensitive) and
// upserted: re-running after the tracker changes corrects the row rather than
// duplicating it. Fields the tracker does not own — `notes`, and the opt-out
// the unsubscribe link sets — are never overwritten.
//
// Usage:
//   node scripts/import-outreach.mjs <csv>
//
// The CSV's first row is a header. Recognised columns (any extras are ignored):
//   practice, suburb, contact, linkedin_profile, email, d0_connect_sent,
//   accepted, dm_link_sent, email_sent, called_demo, followup1_sent,
//   breakup_sent, replied, booked  (and optionally: interested)
// A cell may be blank, a date, or a marker such as 'x' or 'yes'.
//
// Talks to Supabase with the service role key, the same credential the app
// uses. Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment,
// or from .env.local if it exists — exactly as scripts/seed.mjs does.

import { existsSync, readFileSync } from 'node:fs';

import { createClient } from '@supabase/supabase-js';

// One timestamp for the whole run, so every "marked but undated" cell in this
// import gets the same time rather than drifting from row to row.
const NOW = new Date().toISOString();

// Cells that mean "no" or "not yet", on top of a blank cell.
const NEGATIVE = new Set(['', 'no', 'n', 'false', '0', '-', 'none', 'na', 'n/a']);

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

// A small CSV reader: handles quoted fields, commas and newlines inside quotes,
// and "" as an escaped quote. Enough for a spreadsheet export; not a full
// RFC 4180 library.
function parseCsv(input) {
  // Strip a UTF-8 BOM if the export left one on the front.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') endField();
    else if (char === '\r') continue;
    else if (char === '\n') endRow();
    else field += char;
  }
  // Flush the last field/row when the file does not end in a newline.
  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}

// CSV rows → objects keyed by lowercased header, with blank lines dropped.
function toRecords(rows) {
  if (rows.length === 0) return [];
  const header = rows[0].map((name) => name.trim().toLowerCase());
  const records = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    if (cells.every((cell) => cell.trim() === '')) continue;
    const record = {};
    for (let c = 0; c < header.length; c += 1) record[header[c]] = (cells[c] ?? '').trim();
    records.push(record);
  }
  return records;
}

function isMarked(value) {
  return !NEGATIVE.has((value ?? '').trim().toLowerCase());
}

// Does the cell look like a date rather than a plain "x"/"yes" marker?
function looksLikeDate(value) {
  return (
    /^\d{4}-\d{1,2}-\d{1,2}/.test(value) || // 2026-10-01 (ISO)
    /^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}/.test(value) || // 1/10/2026, 01.10.26
    /\d{1,2}\s+[a-z]{3,}\s+\d{2,4}/i.test(value) || // 1 Oct 2026
    /[a-z]{3,}\s+\d{1,2},?\s+\d{2,4}/i.test(value) // Oct 1, 2026
  );
}

// A cadence-step cell → a timestamp. Blank/negative → null. A date → that date.
// Marked but not a date (an "x", a "yes") → the run's NOW.
function stepTimestamp(value) {
  if (!isMarked(value)) return null;
  const trimmed = (value ?? '').trim();
  if (looksLikeDate(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return NOW;
}

function channelFor(hasLinkedin, hasEmail) {
  if (hasLinkedin && hasEmail) return 'linkedin+email';
  if (hasLinkedin) return 'linkedin';
  if (hasEmail) return 'email';
  return null;
}

// Map one tracker row to the outreach columns the tracker owns. `notes` and
// `opted_out_at` are deliberately absent so a re-run never clobbers them.
function buildPayload(record, prospectId) {
  const connect = stepTimestamp(record.d0_connect_sent);
  const dm = stepTimestamp(record.dm_link_sent);
  const email = stepTimestamp(record.email_sent);

  const payload = {
    prospect_id: prospectId,
    contact_name: (record.contact ?? '').trim() || null,
    contact_email: (record.email ?? '').trim().toLowerCase() || null,
    linkedin_url: (record.linkedin_profile ?? '').trim() || null,
    channel: channelFor(Boolean(connect || dm), Boolean(email)),
    connect_sent_at: connect,
    dm_sent_at: dm,
    email_sent_at: email,
    followups_sent: (isMarked(record.followup1_sent) ? 1 : 0) + (isMarked(record.breakup_sent) ? 1 : 0),
    responded_at: stepTimestamp(record.replied),
    booked_at: stepTimestamp(record.booked),
    updated_at: NOW,
  };

  // `interested` only moves off its default when the tracker explicitly says
  // so. The standard cadence columns don't assert interest — a reply or a
  // booking is recorded on its own field — but an optional `interested` column
  // does, if the export has one.
  if ('interested' in record && isMarked(record.interested)) {
    payload.interested = true;
    payload.interested_at = stepTimestamp(record.interested) ?? NOW;
  }

  return payload;
}

// Every prospect, indexed by lowercased practice name, so each tracker row is
// matched in memory (no per-row query, and no ILIKE wildcard surprises). The
// value keeps every id that shares a name, so a collision is caught.
async function loadProspectIndex(supabase) {
  const index = new Map();
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from('prospects')
      .select('id, practice_name')
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) {
      console.error(`Prospect lookup failed: ${error.message}`);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    for (const prospect of data) {
      const key = (prospect.practice_name ?? '').trim().toLowerCase();
      if (!key) continue;
      const existing = index.get(key);
      if (existing) existing.push(prospect.id);
      else index.set(key, [prospect.id]);
    }
    if (data.length < pageSize) break;
  }
  return index;
}

// Idempotent upsert keyed the same way as the unique index,
// (prospect_id, coalesce(contact_email, '')). PostgREST can't express
// ON CONFLICT over that expression, so the row is found and updated, or
// inserted when it is new.
async function upsertOutreach(supabase, prospectId, payload) {
  let find = supabase.from('outreach').select('id').eq('prospect_id', prospectId);
  find = payload.contact_email === null
    ? find.is('contact_email', null)
    : find.eq('contact_email', payload.contact_email);
  const { data: existing, error: findError } = await find.maybeSingle();
  if (findError) {
    console.error(`Outreach lookup failed: ${findError.message}`);
    process.exit(1);
  }

  if (existing) {
    const { error } = await supabase.from('outreach').update(payload).eq('id', existing.id);
    if (error) {
      console.error(`Outreach update failed: ${error.message}`);
      process.exit(1);
    }
    return 'updated';
  }

  const { error } = await supabase.from('outreach').insert(payload);
  if (error) {
    console.error(`Outreach insert failed: ${error.message}`);
    process.exit(1);
  }
  return 'inserted';
}

function printSummary(summary) {
  console.log('');
  console.log('Outreach import complete.');
  console.log(`  rows read:  ${summary.read}`);
  console.log(`  inserted:   ${summary.inserted}`);
  console.log(`  updated:    ${summary.updated}`);
  console.log(`  no match:   ${summary.noMatch.length}`);
  console.log(`  ambiguous:  ${summary.ambiguous.length}`);
  if (summary.noMatch.length > 0) {
    console.log('');
    console.log('No prospect matched these practice names (seed them first, or fix the name):');
    for (const name of summary.noMatch) console.log(`  - ${name}`);
  }
  if (summary.ambiguous.length > 0) {
    console.log('');
    console.log('More than one prospect shares these names; skipped to avoid the wrong one:');
    for (const name of summary.ambiguous) console.log(`  - ${name}`);
  }
}

async function main() {
  loadEnvLocal();

  const csvPath = process.argv[2];
  if (!csvPath || csvPath.startsWith('-')) {
    console.error('Usage: node scripts/import-outreach.mjs <csv>');
    process.exit(1);
  }
  if (!existsSync(csvPath)) {
    console.error(`No such file: ${csvPath}`);
    process.exit(1);
  }

  const supabase = createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const records = toRecords(parseCsv(readFileSync(csvPath, 'utf8')));
  if (records.length === 0) {
    console.log('No rows in the CSV.');
    return;
  }

  const prospects = await loadProspectIndex(supabase);
  const summary = { read: records.length, inserted: 0, updated: 0, noMatch: [], ambiguous: [] };

  for (const record of records) {
    const practice = (record.practice ?? '').trim();
    if (!practice) {
      summary.noMatch.push('(blank practice name)');
      continue;
    }

    const ids = prospects.get(practice.toLowerCase());
    if (!ids) {
      summary.noMatch.push(practice);
      continue;
    }
    if (ids.length > 1) {
      summary.ambiguous.push(practice);
      continue;
    }

    const result = await upsertOutreach(supabase, ids[0], buildPayload(record, ids[0]));
    if (result === 'inserted') summary.inserted += 1;
    else summary.updated += 1;
  }

  printSummary(summary);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
