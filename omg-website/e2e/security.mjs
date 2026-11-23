#!/usr/bin/env node
// Black-box security checks for the OMG booking and reviews Worker.
//
// Written from API.md alone, the way an attacker sees the site: nothing is
// imported from src/ and the database is never touched directly. Every check
// prints PASS or FAIL with a one-line reason; the run exits 1 if any failed.
//
//   BASE_URL        the running Worker (default http://127.0.0.1:8804)
//   ADMIN_PASSWORD  that Worker's ADMIN_PASSWORD
//   --phase=caps    only the global caps. They spend the day's booking and review
//                   budgets and lock the admin login for an hour, so run.sh runs
//                   them last, after the browser check.
//
// Point it at a FRESH database (run.sh makes one): it spends rate-limit and
// global-cap budgets. Every request carries its own CF-Connecting-IP so the
// per-address buckets of different checks never mix. `wrangler dev` passes that
// header through; Cloudflare overwrites it in production, where it cannot be
// used to dodge the limits.

import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes, randomInt } from 'node:crypto';

const BASE = new URL(process.env.BASE_URL || 'http://127.0.0.1:8804');
const ORIGIN = BASE.origin;
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const PHASE = (process.argv.find((a) => a.startsWith('--phase=')) || '--phase=main').slice('--phase='.length);

if (!PASSWORD) {
  console.error('ADMIN_PASSWORD is not set. Use e2e/run.sh, or export the password of the Worker under test.');
  process.exit(2);
}
if (!['main', 'caps'].includes(PHASE)) {
  console.error(`Unknown phase "${PHASE}". Use --phase=main (the default) or --phase=caps.`);
  process.exit(2);
}

// Facts from public/js/catalog.js, the catalogue the page itself loads.
const SERVICE = 'full-glam';
const SERVICE_MINUTES = 90;
const OPEN = 6 * 60;
const CLOSE = 18 * 60;
const STEP = 30;
const MIN_NOTICE = 180;
const MAX_DAYS_AHEAD = 365;
const MAX_BODY = 8 * 1024;
const REF_RE = /^OMG-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;
const COOKIE_NAME = '__Host-omg_admin';

const RUN = randomInt(1, 250);
const NONCE = randomBytes(4).toString('hex');
// Names may only hold letters, so the nonce is spelled in letters for them.
const TAG = NONCE.replace(/\d/g, (d) => 'ghijklmnop'[d]);
const NAME_TAG = TAG[0].toUpperCase() + TAG.slice(1);

// ---------------------------------------------------------------- reporting

const results = [];
let GROUP = 'setup';

function group(name) {
  GROUP = name;
  console.log(`\n== ${name}`);
}

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const snip = (text, n = 140) => {
  const s = oneLine(text);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

// Local dev (wrangler dev) is not Cloudflare: its proxy rewrites a same-host
// Origin to its own scheme, and it reads the whole declared body before the
// Worker sees the request. Checks that depend on either are skipped locally,
// with the reason, rather than reported as failures they are not.
const LOCAL = ['127.0.0.1', 'localhost', '[::1]'].includes(BASE.hostname);

function skip(name, reason) {
  results.push({ group: GROUP, name, ok: true, skipped: true });
  console.log(`SKIP  [${GROUP}] ${name} — ${reason}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ group: GROUP, name, ok: true });
    console.log(`PASS  [${GROUP}] ${name}${detail ? ` — ${snip(detail, 200)}` : ''}`);
  } catch (err) {
    results.push({ group: GROUP, name, ok: false });
    console.log(`FAIL  [${GROUP}] ${name} — ${snip(err?.message ?? err, 400)}`);
  }
}

// ---------------------------------------------------------------- addresses

const GROUP_IDS = {
  preflight: 1, fixtures: 2, sqli: 3, xss: 4, csrf: 5, input: 6, honeypot: 7, privacy: 8,
  headers: 9, admin: 10, ratelimit: 11, global: 12, caps: 13, misc: 14, alerts: 15, content: 16, calendar: 17,
};

/** A test address for `groupName`. Third octet carries the run, so reruns differ. */
function ipFor(groupName, n) {
  const g = GROUP_IDS[groupName] ?? GROUP_IDS.misc;
  return `10.${g}.${(RUN + Math.floor(n / 250)) % 256}.${(n % 250) + 1}`;
}
const ipSeq = {};
/** A new address in the current group, never used before in this run. */
function freshIp(groupName = GROUP) {
  ipSeq[groupName] = (ipSeq[groupName] ?? 0) + 1;
  return ipFor(groupName, ipSeq[groupName]);
}
/** A fixed address freshIp() never hands out. */
const fixedIp = (groupName, n) => ipFor(groupName, 5000 + n);

// ---------------------------------------------------------------- HTTP

const seen = []; // every response, for the run-wide checks at the end

function remember(method, path, status, type, text, raw = false) {
  seen.push({ method, path, status, type: type || '', text: String(text || '').slice(0, 4000), raw });
}

/**
 * One request through fetch. `ip` sets CF-Connecting-IP (a fresh one if
 * omitted). Unsafe methods get this site's Origin unless `origin` says
 * otherwise: false sends none, a string sends that. `json` sends JSON; `raw`
 * sends a string as bytes with `type` as its content type (false: none).
 */
async function call(method, path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  headers.set('cf-connecting-ip', opts.ip || freshIp('misc'));
  if (opts.origin === undefined) {
    if (method !== 'GET' && method !== 'HEAD') headers.set('origin', ORIGIN);
  } else if (opts.origin !== false) {
    headers.set('origin', opts.origin);
  }
  if (opts.cookie) headers.set('cookie', opts.cookie);
  let body;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  } else if (opts.raw !== undefined) {
    body = new TextEncoder().encode(opts.raw);
    if (opts.type !== false && !headers.has('content-type')) headers.set('content-type', opts.type || 'application/json');
  }
  let res;
  try {
    res = await fetch(new URL(path, BASE), {
      method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(opts.timeout ?? 20_000),
    });
  } catch (err) {
    throw new Error(`${method} ${path}: no response (${err.cause?.code || err.name}: ${err.message})`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  remember(method, path, res.status, res.headers.get('content-type'), text);
  return { status: res.status, headers: res.headers, text, json, method, path };
}

/**
 * One request over a raw socket, for what fetch will not send: unnormalised
 * paths, chunked bodies and lying Content-Length headers.
 */
function rawHttp({ method = 'GET', path, headers = {}, body = '', chunked = false, timeout = 6000 }) {
  return new Promise((resolve) => {
    const secure = BASE.protocol === 'https:';
    const port = Number(BASE.port) || (secure ? 443 : 80);
    const socket = secure
      ? tls.connect({ host: BASE.hostname, port, servername: BASE.hostname })
      : net.connect({ host: BASE.hostname, port });
    let data = Buffer.alloc(0);
    let finished = false;
    const finish = (timedOut) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      const text = data.toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      const head = split >= 0 ? text.slice(0, split) : text;
      const out = {
        status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0),
        head,
        body: split >= 0 ? text.slice(split + 4) : '',
        timedOut,
      };
      remember(method, path, out.status, /^content-type:\s*(.+)$/im.exec(head)?.[1], out.body, true);
      resolve(out);
    };
    socket.setTimeout(timeout, () => finish(true));
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
    });
    socket.on('end', () => finish(false));
    socket.on('close', () => finish(false));
    socket.on('error', () => finish(false));
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      const lines = [`${method} ${path} HTTP/1.1`, `Host: ${BASE.host}`, 'Connection: close'];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      if (chunked) lines.push('Transfer-Encoding: chunked');
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      const buf = Buffer.from(body);
      if (chunked) {
        for (let i = 0; i < buf.length; i += 1024) {
          const part = buf.subarray(i, i + 1024);
          socket.write(`${part.length.toString(16)}\r\n`);
          socket.write(part);
          socket.write('\r\n');
        }
        socket.write('0\r\n\r\n');
      } else if (buf.length) {
        socket.write(buf);
      }
    });
  });
}

const rawHeaders = (extra = {}) => ({ Origin: ORIGIN, 'CF-Connecting-IP': freshIp(), ...extra });

// ---------------------------------------------------------------- assertions

function expectStatus(r, allowed, what = `${r.method} ${r.path}`) {
  const list = [].concat(allowed);
  assert.ok(list.includes(r.status), `${what}: expected ${list.join(' or ')}, got ${r.status} ${snip(r.text)}`);
}

/** Checks an error reply against API.md and returns a short description. */
function expectError(r, status, code, field) {
  expectStatus(r, status);
  assert.equal(r.json?.ok, false, `${r.method} ${r.path}: body is not { ok: false }: ${snip(r.text)}`);
  if (code) assert.equal(r.json?.error, code, `${r.method} ${r.path}: error "${r.json?.error}", expected "${code}"`);
  if (field && r.json?.field !== undefined) {
    assert.equal(r.json.field, field, `${r.method} ${r.path}: field "${r.json.field}", expected "${field}"`);
  }
  return `${r.status} ${r.json?.error}${r.json?.field ? ` (${r.json.field})` : ''}`;
}

function assertRetryAfter(r) {
  const header = r.headers.get('retry-after');
  assert.match(String(header), /^\d+$/, `Retry-After header is ${header}`);
  assert.ok(Number(header) >= 1, `Retry-After is ${header}`);
  assert.equal(r.json?.retryAfter, Number(header), `body retryAfter ${r.json?.retryAfter} does not match the header ${header}`);
}

function assertReviewsShape(j) {
  assert.equal(j?.ok, true, 'ok is not true');
  assert.ok(Array.isArray(j.reviews), 'reviews is not an array');
  assert.ok(Number.isInteger(j.count), `count is ${j.count}`);
  assert.ok(j.average === null || typeof j.average === 'number', `average is ${j.average}`);
  assert.equal(typeof j.hasMore, 'boolean', `hasMore is ${j.hasMore}`);
}

// ---------------------------------------------------------------- cookies

function setCookies(res) {
  return typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
}

function parseCookie(line) {
  const [pair, ...attrs] = line.split(';').map((s) => s.trim());
  const eq = pair.indexOf('=');
  const parsed = {};
  for (const attr of attrs) {
    const [k, ...v] = attr.split('=');
    parsed[k.toLowerCase()] = v.length ? v.join('=') : true;
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs: parsed };
}

function sessionCookie(res) {
  const c = setCookies(res).map(parseCookie).find((x) => x.name === COOKIE_NAME);
  return c && c.value ? `${c.name}=${c.value}` : null;
}

// ---------------------------------------------------------------- dates

function sastNow() {
  const t = new Date(Date.now() + 120 * 60_000);
  return { date: t.toISOString().slice(0, 10), minutes: t.getUTCHours() * 60 + t.getUTCMinutes() };
}
function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const monthOf = (date) => date.slice(0, 7);

let TODAY = sastNow().date;
let NOW_MIN = sastNow().minutes;
const dateAt = (n) => addDays(TODAY, n);

// ---------------------------------------------------------------- builders

let phoneSeq = 0;
const PHONE_PREFIX = PHASE === 'caps' ? '072' : '071';
function newPhone() {
  phoneSeq += 1;
  return `${PHONE_PREFIX} ${String(RUN).padStart(3, '0')} ${String(phoneSeq).padStart(4, '0')}`;
}
const digits = (s) => String(s).replace(/\D/g, '');

let markSeq = 0;
/** A marker to find a review again; plain ASCII so no normalisation touches it. */
const newMark = () => `[m${NONCE}${(markSeq += 1)}]`;

function booking(over = {}) {
  return {
    name: `Test ${NAME_TAG}`, phone: newPhone(), service: SERVICE, date: dateAt(50), time: '10:00',
    company: '', elapsed: 30_000, ...over,
  };
}

function review(over = {}) {
  return {
    name: 'Test Reviewer', rating: 4, comment: `Lovely service, will be back. ${newMark()}`,
    company: '', elapsed: 30_000, ...over,
  };
}

// ---------------------------------------------------------------- admin

const ADMIN = { cookie: null, ip: fixedIp('admin', 1), why: 'the preflight login has not run' };
const FX = {}; // fixtures shared between groups

function needAdmin() {
  if (!ADMIN.cookie) throw new Error(`no admin session (${ADMIN.why})`);
}

async function admin(method, path, opts = {}) {
  needAdmin();
  return call(method, path, { ip: ADMIN.ip, cookie: ADMIN.cookie, ...opts });
}

async function adminList(path, key) {
  const r = await admin('GET', path);
  expectStatus(r, 200);
  assert.ok(Array.isArray(r.json?.[key]), `${path}: "${key}" is not an array: ${snip(r.text)}`);
  return r.json[key];
}

const pendingRequests = () => adminList('/api/admin/requests', 'requests');
const adminReviews = (status) => adminList(`/api/admin/reviews?status=${status}`, 'reviews');
const adminBlocks = (from, to) => adminList(`/api/admin/blocks?from=${from}&to=${to}`, 'blocks');

// ---------------------------------------------------------------- public reviews

let cacheBust = true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function publicReviewsPage(page) {
  const bust = cacheBust ? `&cb=${Date.now()}${randomInt(1_000_000)}` : '';
  let r = await call('GET', `/api/reviews?page=${page}${bust}`);
  if (cacheBust && r.status === 400) {
    cacheBust = false; // the Worker refuses unknown parameters; poll instead
    r = await call('GET', `/api/reviews?page=${page}`);
  }
  expectStatus(r, 200, `GET /api/reviews?page=${page}`);
  assertReviewsShape(r.json);
  return r.json;
}

async function allPublicReviews(maxPages = 30) {
  const all = [];
  let first;
  for (let p = 1; p <= maxPages; p += 1) {
    const j = await publicReviewsPage(p);
    first ??= j;
    all.push(...j.reviews);
    if (!j.hasMore) break;
  }
  return { all, first };
}

/** Polls the public list for a review, allowing for up to a minute of caching. */
async function waitForPublicReview(mark, waitMs = 75_000) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const { all } = await allPublicReviews();
    const hit = all.find((x) => typeof x.comment === 'string' && x.comment.includes(mark));
    if (hit || Date.now() > deadline) return hit ?? null;
    await sleep(3000);
  }
}

/** Posts a review; if accepted, approves it and returns the stored and public copies. */
async function postApprovePublish(body, mark, ip) {
  const posted = await call('POST', '/api/reviews', { ip, json: body });
  if (posted.status !== 201) return { posted };
  const mine = (await adminReviews('pending')).find((x) => String(x.comment).includes(mark));
  assert.ok(mine, `review ${mark} got 201 but is not in the admin pending list`);
  const approved = await admin('POST', `/api/admin/reviews/${mine.id}/approve`, { json: {} });
  expectStatus(approved, 200);
  const pub = await waitForPublicReview(mark);
  return { posted, stored: mine, pub };
}

// ================================================================ groups

async function preflight() {
  group('preflight');
  const ip = fixedIp('preflight', 1);
  try {
    const r = await call('GET', '/', { ip });
    if (r.status === 0) throw new Error('no status');
  } catch (err) {
    console.log(`FAIL  [preflight] nothing answers at ${ORIGIN} — ${oneLine(err.message)}`);
    process.exit(2);
  }

  await check('GET / serves the site as HTML', async () => {
    const r = await call('GET', '/', { ip });
    expectStatus(r, 200);
    assert.match(r.headers.get('content-type') || '', /^text\/html/i, `content-type ${r.headers.get('content-type')}`);
  });

  await check('GET /api/availability for this month has the documented shape', async () => {
    const month = monthOf(sastNow().date);
    const r = await call('GET', `/api/availability?month=${month}`, { ip });
    expectStatus(r, 200);
    const j = r.json;
    assert.equal(j?.ok, true, 'ok is not true');
    assert.equal(j.month, month, `month came back as ${j.month}`);
    assert.match(String(j.today), /^\d{4}-\d{2}-\d{2}$/, `today is ${j.today}`);
    assert.match(String(j.now), /^\d{2}:\d{2}$/, `now is ${j.now}`);
    assert.ok(j.busy && typeof j.busy === 'object' && !Array.isArray(j.busy), 'busy is not an object');
    TODAY = j.today;
    NOW_MIN = toMin(j.now);
    return `today ${j.today}, now ${j.now} SAST`;
  });

  await check('admin login with the right password opens a session', async () => {
    const r = await call('POST', '/api/admin/login', { ip: ADMIN.ip, json: { password: PASSWORD } });
    ADMIN.why = `login returned ${r.status} ${snip(r.text, 80)}`;
    expectStatus(r, 200);
    const cookie = sessionCookie(r);
    if (!cookie) ADMIN.why = `login returned 200 but set no ${COOKIE_NAME} cookie`;
    assert.ok(cookie, ADMIN.why);
    ADMIN.cookie = cookie;
    return 'cookie received';
  });

  await check('the session cookie is accepted', async () => {
    const r = await admin('GET', '/api/admin/session');
    expectStatus(r, 200);
    assert.equal(r.json?.ok, true, 'ok is not true');
    const p = r.json?.pending;
    assert.ok(Number.isInteger(p?.requests) && Number.isInteger(p?.reviews), `pending counts missing: ${snip(r.text)}`);
    return `pending: ${p.requests} requests, ${p.reviews} reviews`;
  });

  await check('a correct same-origin POST is accepted (baseline for the Origin checks)', async () => {
    FX.pendingReviewMark = newMark();
    const r = await call('POST', '/api/reviews', {
      ip: freshIp(), json: review({ comment: `Baseline review, it stays pending. ${FX.pendingReviewMark}` }),
    });
    if (r.status === 403) {
      throw new Error(`403 although Origin is ${ORIGIN}: check how the Worker works out its own origin under wrangler dev`);
    }
    expectStatus(r, 201);
    return '201';
  });
}

async function fixtures() {
  group('fixtures');
  FX.d1 = dateAt(40);
  FX.d2 = dateAt(41);
  FX.d3 = dateAt(42);
  FX.d4 = dateAt(43);
  FX.name1 = `Fixture ${NAME_TAG}`;
  FX.phone1 = newPhone();
  FX.name2 = `Pending ${NAME_TAG}`;
  FX.phone2 = newPhone();
  FX.label3 = `Secret label ${NONCE}`;

  await check('a booking request is accepted with a ref and a WhatsApp link', async () => {
    const r = await call('POST', '/api/bookings', {
      ip: freshIp(), json: booking({ name: FX.name1, phone: FX.phone1, date: FX.d1, time: '10:00' }),
    });
    expectStatus(r, 201);
    assert.match(String(r.json?.ref), REF_RE, `ref is ${r.json?.ref}`);
    FX.ref1 = r.json.ref;
    FX.bookingKeys = Object.keys(r.json).sort();
    const url = String(r.json.whatsappUrl || '');
    assert.ok(url.startsWith('https://wa.me/27785767604?text='), `whatsappUrl is ${snip(url, 60)}`);
    const text = decodeURIComponent(url.split('?text=')[1] || '');
    for (const want of [`Name and Surname: ${FX.name1}`, `Contact Number: ${FX.phone1}`, `Ref: ${FX.ref1}`]) {
      assert.ok(text.includes(want), `the WhatsApp text lacks "${want}"`);
    }
    return FX.ref1;
  });

  await check('OMG confirms it on the admin page', async () => {
    const mine = (await pendingRequests()).find((x) => x.ref === FX.ref1);
    assert.ok(mine, `${FX.ref1} is not in the pending list`);
    FX.id1 = mine.id;
    const r = await admin('POST', `/api/admin/requests/${mine.id}/confirm`, { json: {} });
    expectStatus(r, 200);
    FX.block1 = r.json?.block;
    assert.ok(FX.block1?.id, `no block in ${snip(r.text)}`);
    assert.equal(FX.block1.start, '10:00', `block starts ${FX.block1.start}`);
    assert.equal(FX.block1.end, hhmm(600 + SERVICE_MINUTES), `block ends ${FX.block1.end}`);
    return `block ${FX.block1.id}: ${FX.block1.date} ${FX.block1.start}–${FX.block1.end}`;
  });

  await check('a second request stays pending', async () => {
    const r = await call('POST', '/api/bookings', {
      ip: freshIp(), json: booking({ name: FX.name2, phone: FX.phone2, date: FX.d2, time: '10:00' }),
    });
    expectStatus(r, 201);
    FX.ref2 = r.json.ref;
    const mine = (await pendingRequests()).find((x) => x.ref === FX.ref2);
    assert.ok(mine, `${FX.ref2} is not in the pending list`);
    FX.id2 = mine.id;
    return `${FX.ref2}, id ${FX.id2}`;
  });

  await check('OMG blocks a whole day off with a private note', async () => {
    const r = await admin('POST', '/api/admin/blocks', {
      json: { date: FX.d3, start: '00:00', end: '24:00', kind: 'closed', label: FX.label3 },
    });
    expectStatus(r, 201);
    FX.block3 = r.json?.block;
    assert.ok(FX.block3?.id, `no block in ${snip(r.text)}`);
    return `block ${FX.block3.id}`;
  });

  await check('a review is accepted, approved and published', async () => {
    FX.reviewMark = newMark();
    const out = await postApprovePublish(review({ comment: `Fixture review, approved. ${FX.reviewMark}` }), FX.reviewMark, freshIp());
    expectStatus(out.posted, 201);
    assert.ok(out.pub, 'not visible publicly after approval');
    FX.review1 = out.pub;
    FX.publicCount = (await allPublicReviews(1)).first.count;
    return `public id ${out.pub.id}, ${FX.publicCount} published`;
  });

  await check('the baseline review is still pending (canary for the id checks)', async () => {
    const mine = (await adminReviews('pending')).find((x) => String(x.comment).includes(FX.pendingReviewMark ?? '<none>'));
    assert.ok(mine, 'the baseline review is not in the pending list');
    FX.pendingReviewId = mine.id;
    return `id ${mine.id}`;
  });
}

/** Proves the fixtures are untouched: nothing dropped, deleted, approved or declined. */
async function survival(label) {
  await check(`${label}: confirmed booking and day off still in the calendar`, async () => {
    const blocks = await adminBlocks(FX.d1, FX.d3);
    assert.ok(blocks.some((b) => b.id === FX.block1?.id), `block ${FX.block1?.id} is gone`);
    assert.ok(blocks.some((b) => b.id === FX.block3?.id), `block ${FX.block3?.id} is gone`);
    const r = await call('GET', `/api/availability?month=${monthOf(FX.d1)}`);
    expectStatus(r, 200);
    const ranges = r.json?.busy?.[FX.d1] ?? [];
    assert.ok(ranges.some(([s, e]) => s <= '10:00' && e >= hhmm(600 + SERVICE_MINUTES)), `busy on ${FX.d1}: ${JSON.stringify(ranges)}`);
  });
  await check(`${label}: the pending request is still pending`, async () => {
    assert.ok((await pendingRequests()).some((x) => x.id === FX.id2), `request ${FX.id2} left the pending list`);
  });
  await check(`${label}: reviews intact (baseline still pending, fixture still public)`, async () => {
    assert.ok((await adminReviews('pending')).some((x) => x.id === FX.pendingReviewId), `review ${FX.pendingReviewId} left the pending list`);
    const { all, first } = await allPublicReviews();
    assert.ok(all.some((x) => x.id === FX.review1?.id), `review ${FX.review1?.id} is no longer public`);
    assert.ok(first.count >= (FX.publicCount ?? 0), `count fell from ${FX.publicCount} to ${first.count}`);
    return `${first.count} published`;
  });
}

const SQLI = [
  `' OR '1'='1`,
  `'; DROP TABLE reviews;--`,
  `1 UNION SELECT name, sql FROM sqlite_master--`,
  `\\' OR 1=1 -- `,
  `1/**/OR/**/1=1`,
  `" OR ""="`,
];

async function sqli() {
  group('sqli');
  const month = monthOf(TODAY);

  for (const p of [...SQLI, `${month}' OR '1'='1`, `${month}'--`]) {
    await check(`availability month=${p} → 400`, async () =>
      expectError(await call('GET', `/api/availability?month=${encodeURIComponent(p)}`), 400, 'invalid'));
  }

  for (const p of SQLI) {
    await check(`reviews page=${p} → 400 or the normal page`, async () => {
      const r = await call('GET', `/api/reviews?page=${encodeURIComponent(p)}`);
      expectStatus(r, [200, 400]);
      if (r.status === 200) assertReviewsShape(r.json);
      assert.ok(!/sqlite_master|CREATE TABLE/i.test(r.text), 'the reply mentions the schema');
      return String(r.status);
    });
  }

  for (const field of ['name', 'phone', 'service', 'date', 'time']) {
    for (const p of SQLI.slice(0, 4)) {
      await check(`booking ${field}=${p} → 400`, async () =>
        expectError(await call('POST', '/api/bookings', { ip: freshIp(), json: booking({ [field]: p }) }), 400, 'invalid', field));
    }
  }

  for (const p of SQLI.slice(0, 4)) {
    await check(`review name=${p} → 400`, async () =>
      expectError(await call('POST', '/api/reviews', { ip: freshIp(), json: review({ name: p }) }), 400, 'invalid', 'name'));
  }

  await check('a name with apostrophes is stored exactly (bound, not concatenated)', async () => {
    const name = `D'Angelo O'Neil ${NAME_TAG}`;
    const r = await call('POST', '/api/bookings', { ip: freshIp(), json: booking({ name, date: FX.d2, time: '13:00' }) });
    expectStatus(r, 201);
    const mine = (await pendingRequests()).find((x) => x.ref === r.json.ref);
    assert.ok(mine, 'not in the pending list');
    assert.equal(mine.name, name, `stored as ${JSON.stringify(mine.name)}`);
    return mine.name;
  });

  for (const comment of [`Loved it'); DROP TABLE reviews;-- truly`, `' OR '1'='1 -- still a lovely visit`]) {
    await check(`review comment "${comment}" is stored and published verbatim`, async () => {
      const mark = newMark();
      const full = `${comment} ${mark}`;
      const out = await postApprovePublish(review({ comment: full }), mark, freshIp());
      expectStatus(out.posted, 201);
      assert.ok(out.pub, 'not visible after approval');
      assert.equal(out.pub.comment, full, `came back as ${JSON.stringify(out.pub.comment)}`);
      return 'verbatim';
    });
  }

  // Ids: anything but a positive integer is a 404. A Worker that parses the
  // leading digits ("2;DELETE" → 2) acts on a real row, which survival() catches.
  const idCases = [
    ['POST', `/api/admin/requests/${FX.id2}%20OR%201%3D1/decline`],
    ['POST', `/api/admin/requests/${FX.id2};DELETE/decline`],
    ['POST', `/api/admin/requests/${FX.id2}'--/confirm`],
    ['POST', '/api/admin/requests/%27/decline'],
    ['POST', '/api/admin/requests/-1/confirm'],
    ['POST', '/api/admin/requests/0/confirm'],
    ['POST', '/api/admin/requests/99999999999999999999999/confirm'],
    ['DELETE', `/api/admin/blocks/${FX.block3?.id}%20OR%201%3D1`],
    ['DELETE', `/api/admin/blocks/${FX.block3?.id};`],
    ['POST', `/api/admin/reviews/${FX.pendingReviewId}--/approve`],
    ['DELETE', `/api/admin/reviews/${FX.pendingReviewId}%3B%20DELETE%20FROM%20reviews`],
    ['DELETE', `/api/admin/reviews/${FX.pendingReviewId}%20UNION%20SELECT%201`],
  ];
  for (const [method, path] of idCases) {
    await check(`${method} ${path} → 404`, async () =>
      expectError(await admin(method, path, method === 'POST' ? { json: {} } : {}), 404, 'not_found'));
  }

  const fromTo = [
    [`${FX.d1}' OR '1'='1`, FX.d3],
    [FX.d1, `${FX.d3}'--`],
    ['1 UNION SELECT 1,2,3--', FX.d3],
    [FX.d1, `${FX.d3}" OR ""="`],
  ];
  for (const [from, to] of fromTo) {
    await check(`admin blocks from=${from}&to=${to} → 400`, async () =>
      expectError(await admin('GET', `/api/admin/blocks?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`), 400, 'invalid'));
  }

  for (const p of SQLI.slice(0, 3)) {
    await check(`admin reviews status=${p} → 400 or a normal list`, async () => {
      const r = await admin('GET', `/api/admin/reviews?status=${encodeURIComponent(p)}`);
      expectStatus(r, [200, 400]);
      if (r.status === 200) assert.ok(Array.isArray(r.json?.reviews), 'reviews is not an array');
      return String(r.status);
    });
  }

  for (const p of SQLI.slice(0, 4)) {
    await check(`login password=${p} → 401`, async () => {
      const r = await call('POST', '/api/admin/login', { ip: freshIp(), json: { password: p } });
      const detail = expectError(r, 401, 'bad_password');
      assert.ok(!sessionCookie(r), 'a session cookie was set');
      return detail;
    });
  }

  await survival('after the injection attempts');
}

const XSS = [
  '<script>window.__pwned=1</script> lovely service',
  `<img src=x onerror="window.__pwned=1"> "quotes" & 'apostrophes'`,
  'javascript:window.__pwned=1 ${7*7} {{7*7}} <%= 7*7 %>',
  '"><svg onload=window.__pwned=1> </textarea></title><!--',
];

/** Problems with inline script in an HTML page: the CSP is script-src 'self'. */
function htmlScriptProblems(html) {
  const problems = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1];
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    const src = /\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1];
    // Data blocks (Google's listing data, the booking calendar's services) never run;
    // each must still be well-formed JSON, so nothing was spliced into it.
    if (type === 'application/ld+json' || type === 'application/json') {
      try {
        JSON.parse(m[2]);
      } catch {
        problems.push(`a ${type} block that is not valid JSON: ${snip(m[2], 50)}`);
      }
      continue;
    }
    if (src) {
      if (m[2].trim()) problems.push('a <script src> with inline code too');
      if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(src) && !src.startsWith(ORIGIN)) problems.push(`a script from ${src}`);
      continue;
    }
    problems.push(`inline <script>: ${snip(m[2], 50)}`);
  }
  for (const m of html.matchAll(/<[a-zA-Z][^<>]*>/g)) {
    if (/\son[a-z]+\s*=/i.test(m[0])) problems.push(`inline handler: ${snip(m[0], 80)}`);
    if (/\b(?:href|src|action|formaction)\s*=\s*["']?\s*javascript:/i.test(m[0])) problems.push(`javascript: URL: ${snip(m[0], 80)}`);
  }
  return problems;
}

function parseCsp(value) {
  const map = new Map();
  for (const part of String(value || '').split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) map.set(name.toLowerCase(), sources);
  }
  return map;
}

function cspProblems(value) {
  if (!value) return ['no Content-Security-Policy'];
  const csp = parseCsp(value);
  const out = [];
  const exact = {
    'object-src': "'none'", 'base-uri': "'none'", 'frame-ancestors': "'none'",
    'form-action': "'self'", 'connect-src': "'self'",
  };
  for (const dir of ['default-src', 'script-src']) {
    const got = csp.get(dir);
    if (!got) out.push(`CSP lacks ${dir}`);
    else if (got.some((s) => s !== "'self'")) out.push(`CSP ${dir} also allows ${got.filter((s) => s !== "'self'").join(' ')}`);
  }
  for (const [dir, want] of Object.entries(exact)) {
    const got = csp.get(dir);
    if (!got) out.push(`CSP lacks ${dir}`);
    else if (got.join(' ') !== want) out.push(`CSP ${dir} is "${got.join(' ')}"`);
  }
  const img = csp.get('img-src') || [];
  if (img.some((s) => ['*', 'http:', 'https:'].includes(s))) out.push(`CSP img-src ${img.join(' ')}`);
  if (BASE.protocol === 'https:' && !csp.has('upgrade-insecure-requests')) out.push('CSP lacks upgrade-insecure-requests over https');
  return out;
}

async function xss() {
  group('xss');

  for (const payload of XSS) {
    await check(`review comment ${JSON.stringify(payload)} is refused or comes back verbatim`, async () => {
      const mark = newMark();
      const full = `${payload} ${mark}`;
      const out = await postApprovePublish(review({ comment: full }), mark, freshIp());
      expectStatus(out.posted, [201, 400]);
      if (out.posted.status === 400) return 'refused';
      assert.ok(out.pub, 'not visible after approval');
      assert.equal(out.stored.comment, full, `admin copy ${JSON.stringify(out.stored.comment)}`);
      assert.equal(out.pub.comment, full, `public copy ${JSON.stringify(out.pub.comment)}`);
      return 'stored and returned verbatim (escaping is the page\'s job)';
    });
  }

  await check('review name "<b>Lerato</b>" is refused or comes back verbatim', async () => {
    const mark = newMark();
    const out = await postApprovePublish(review({ name: '<b>Lerato</b>', comment: `Lovely, truly. ${mark}` }), mark, freshIp());
    expectStatus(out.posted, [201, 400]);
    if (out.posted.status === 400) return 'refused';
    assert.equal(out.pub?.name, '<b>Lerato</b>', `came back as ${JSON.stringify(out.pub?.name)}`);
    return 'verbatim';
  });

  await check('booking name with a <script> payload → 400', async () =>
    expectError(await call('POST', '/api/bookings', { ip: freshIp(), json: booking({ name: '<script>alert(1)</script> Smith' }) }), 400, 'invalid', 'name'));

  await check('booking phone with an <img onerror> payload → 400', async () =>
    expectError(await call('POST', '/api/bookings', { ip: freshIp(), json: booking({ phone: '<img src=x onerror=alert(1)>' }) }), 400, 'invalid', 'phone'));

  for (const path of ['/', '/admin/']) {
    await check(`${path} has no inline script, inline handlers or javascript: URLs`, async () => {
      const r = await call('GET', path);
      expectStatus(r, 200);
      const problems = htmlScriptProblems(r.text);
      assert.equal(problems.length, 0, problems.slice(0, 4).join('; '));
      return `${(r.text.match(/<script\b/gi) || []).length} script tags, all external or JSON-LD`;
    });
  }

  await check('the CSP forbids inline and foreign script', async () => {
    const r = await call('GET', '/');
    const problems = cspProblems(r.headers.get('content-security-policy'));
    assert.equal(problems.length, 0, problems.join('; '));
    return snip(r.headers.get('content-security-policy'), 90);
  });

  await check('API replies are JSON with nosniff, so a browser never renders them as HTML', async () => {
    for (const r of [
      await call('GET', `/api/availability?month=${monthOf(TODAY)}`),
      await call('GET', '/api/availability?month=<script>alert(1)</script>'),
      await call('GET', '/api/reviews?page=1'),
    ]) {
      assert.match(r.headers.get('content-type') || '', /^application\/json/i, `${r.path}: content-type ${r.headers.get('content-type')}`);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', `${r.path}: no nosniff`);
    }
  });
}

async function csrf() {
  group('csrf');
  const port = Number(BASE.port) || (BASE.protocol === 'https:' ? 443 : 80);
  const origins = [
    ['no Origin', false],
    ['a foreign Origin', 'https://evil.example'],
    ['Origin: null', 'null'],
    ['another port on the same host', `${BASE.protocol}//${BASE.hostname}:${port + 1}`],
    ['the other scheme on the same host', `${BASE.protocol === 'https:' ? 'http' : 'https'}://${BASE.host}`],
  ];

  for (const [label, origin] of origins) {
    if (LOCAL && label === 'the other scheme on the same host') {
      const why = 'wrangler dev rewrites a same-host Origin to its own scheme before the Worker sees it; on Cloudflare the exact-match check refuses it';
      skip(`POST /api/bookings with ${label} → 403`, why);
      skip(`POST /api/reviews with ${label} → 403`, why);
      continue;
    }
    await check(`POST /api/bookings with ${label} → 403`, async () =>
      expectError(await call('POST', '/api/bookings', { ip: freshIp(), origin, json: booking() }), 403, 'forbidden'));
    await check(`POST /api/reviews with ${label} → 403`, async () =>
      expectError(await call('POST', '/api/reviews', { ip: freshIp(), origin, json: review() }), 403, 'forbidden'));
  }

  for (const [label, origin] of origins.slice(0, 3)) {
    await check(`login with the right password but ${label} → 403, no session`, async () => {
      const r = await call('POST', '/api/admin/login', { ip: freshIp(), origin, json: { password: PASSWORD } });
      const detail = expectError(r, 403, 'forbidden');
      assert.ok(!sessionCookie(r), 'a session cookie was set');
      return detail;
    });
  }

  await check('admin block POST with a session but a foreign Origin → 403, nothing created', async () => {
    const r = await admin('POST', '/api/admin/blocks', {
      origin: 'https://evil.example', json: { date: FX.d4, start: '08:00', end: '09:00', kind: 'closed', label: 'csrf' },
    });
    const detail = expectError(r, 403, 'forbidden');
    assert.equal((await adminBlocks(FX.d4, FX.d4)).length, 0, 'the block was created anyway');
    return detail;
  });

  await check('admin block DELETE with a session but no Origin → 403, block kept', async () => {
    const detail = expectError(await admin('DELETE', `/api/admin/blocks/${FX.block3?.id}`, { origin: false }), 403, 'forbidden');
    assert.ok((await adminBlocks(FX.d3, FX.d3)).some((b) => b.id === FX.block3?.id), 'the block was deleted anyway');
    return detail;
  });

  await check('confirming a request with Origin: null → 403, still pending', async () => {
    const detail = expectError(await admin('POST', `/api/admin/requests/${FX.id2}/confirm`, { origin: 'null', json: {} }), 403, 'forbidden');
    assert.ok((await pendingRequests()).some((x) => x.id === FX.id2), 'the request left the pending list');
    return detail;
  });

  await check('declining a request with a foreign Origin → 403, still pending', async () => {
    const detail = expectError(await admin('POST', `/api/admin/requests/${FX.id2}/decline`, { origin: 'https://evil.example', json: {} }), 403, 'forbidden');
    assert.ok((await pendingRequests()).some((x) => x.id === FX.id2), 'the request left the pending list');
    return detail;
  });

  await check('approving a review with a foreign Origin → 403, still pending', async () => {
    const detail = expectError(await admin('POST', `/api/admin/reviews/${FX.pendingReviewId}/approve`, { origin: 'https://evil.example', json: {} }), 403, 'forbidden');
    assert.ok((await adminReviews('pending')).some((x) => x.id === FX.pendingReviewId), 'the review left the pending list');
    return detail;
  });

  await check('deleting a review with no Origin → 403, review kept', async () => {
    const detail = expectError(await admin('DELETE', `/api/admin/reviews/${FX.pendingReviewId}`, { origin: false }), 403, 'forbidden');
    assert.ok((await adminReviews('pending')).some((x) => x.id === FX.pendingReviewId), 'the review was deleted anyway');
    return detail;
  });

  await check('logout with a foreign Origin → 403, session still valid', async () => {
    const detail = expectError(await admin('POST', '/api/admin/logout', { origin: 'https://evil.example', json: {} }), 403, 'forbidden');
    expectStatus(await admin('GET', '/api/admin/session'), 200, 'the session after the refused logout');
    return detail;
  });

  const types = [
    ['/api/bookings', 'text/plain', () => JSON.stringify(booking())],
    ['/api/reviews', 'application/x-www-form-urlencoded', () => 'name=Test+Reviewer&rating=4&comment=Lovely+service+again'],
    ['/api/admin/login', 'multipart/form-data; boundary=xyz', () => `--xyz\r\nContent-Disposition: form-data; name="password"\r\n\r\n${PASSWORD}\r\n--xyz--\r\n`],
    ['/api/bookings', 'text/plain; charset=application/json', () => JSON.stringify(booking())],
    ['/api/reviews', 'application/x-www-form-urlencoded; x=application/json', () => JSON.stringify(review())],
    ['/api/bookings', false, () => JSON.stringify(booking())],
  ];
  for (const [path, type, body] of types) {
    await check(`POST ${path} as ${type || 'no Content-Type'} → 415`, async () => {
      const r = await call('POST', path, { ip: freshIp(), raw: body(), type });
      const detail = expectError(r, 415, 'unsupported_media_type');
      assert.ok(!sessionCookie(r), 'a session cookie was set');
      return detail;
    });
  }

  await check('admin block POST with a session but no Content-Type → 415', async () =>
    expectError(await admin('POST', '/api/admin/blocks', {
      raw: JSON.stringify({ date: FX.d4, start: '08:00', end: '09:00', kind: 'closed' }), type: false,
    }), 415, 'unsupported_media_type'));

  await check('"application/json; charset=utf-8" is accepted', async () => {
    const r = await call('POST', '/api/reviews', {
      ip: freshIp(), raw: JSON.stringify(review()), type: 'application/json; charset=utf-8',
    });
    expectStatus(r, 201);
    return '201';
  });
}

async function input() {
  group('input');
  const big = (n) => 'x'.repeat(n);
  const D = dateAt(52);

  await check('a body over 8 KB with an honest Content-Length → 413', async () =>
    expectError(await call('POST', '/api/reviews', { ip: freshIp(), json: review({ comment: big(MAX_BODY + 500) }) }), 413, 'too_large'));

  await check('a body over 8 KB sent chunked, with no Content-Length → 413', async () => {
    const body = JSON.stringify(review({ comment: big(MAX_BODY + 500) }));
    const r = await rawHttp({ method: 'POST', path: '/api/reviews', headers: rawHeaders({ 'Content-Type': 'application/json' }), body, chunked: true });
    assert.equal(r.status, 413, `got ${r.status || 'no reply'}${r.timedOut ? ' (timed out)' : ''} ${snip(r.body)}`);
    return '413';
  });

  await check('a Content-Length that understates a 9 KB body → refused', async () => {
    const body = JSON.stringify(review({ comment: big(MAX_BODY + 1000) }));
    const r = await rawHttp({ method: 'POST', path: '/api/reviews', headers: rawHeaders({ 'Content-Type': 'application/json', 'Content-Length': '20' }), body });
    assert.ok([400, 413].includes(r.status), `got ${r.status || 'no reply'} ${snip(r.body)}`);
    return String(r.status);
  });

  if (LOCAL) skip('a Content-Length claiming 100 KB → 413 straight from the header', 'wrangler dev waits for the whole declared body before the Worker runs; on Cloudflare readJson refuses it from the header first');
  else await check('a Content-Length claiming 100 KB → 413 straight from the header', async () => {
    const r = await rawHttp({
      method: 'POST', path: '/api/reviews', timeout: 5000,
      headers: rawHeaders({ 'Content-Type': 'application/json', 'Content-Length': '100000' }), body: '{"name":"x"}',
    });
    assert.equal(r.status, 413, r.status ? `got ${r.status} ${snip(r.body)}` : 'no reply in 5 s: the Worker waited for a body it should have refused from the header');
    return '413';
  });

  const shapes = [
    ['malformed JSON', '{"name": "x",'], ['a JSON array', '[]'], ['a JSON string', '"hello"'],
    ['JSON null', 'null'], ['a JSON number', '42'], ['JSON true', 'true'], ['an empty body', ''],
  ];
  for (const [label, raw] of shapes) {
    await check(`bookings: ${label} → 400`, async () =>
      expectError(await call('POST', '/api/bookings', { ip: freshIp(), raw }), 400));
  }
  for (const [label, raw] of shapes.slice(0, 2)) {
    await check(`reviews: ${label} → 400`, async () =>
      expectError(await call('POST', '/api/reviews', { ip: freshIp(), raw }), 400));
    await check(`admin blocks: ${label} → 400`, async () =>
      expectError(await admin('POST', '/api/admin/blocks', { raw }), 400));
  }
  await check('login: malformed JSON → 400 or 401, no session', async () => {
    const r = await call('POST', '/api/admin/login', { ip: freshIp(), raw: '{"password": ' });
    expectStatus(r, [400, 401]);
    assert.ok(!sessionCookie(r), 'a session cookie was set');
    return String(r.status);
  });

  const ratings = [
    ['"5" (a string)', '"5"'], ['4.5', '4.5'], ['0', '0'], ['6', '6'], ['-1', '-1'], ['true', 'true'],
    ['null', 'null'], ['[4]', '[4]'], ['1e309 (Infinity)', '1e309'], ['9007199254740993', '9007199254740993'],
  ];
  for (const [label, raw] of ratings) {
    await check(`rating ${label} → 400`, async () => {
      const body = `{"name":"Test Reviewer","rating":${raw},"comment":"Lovely service, will be back.","company":"","elapsed":30000}`;
      return expectError(await call('POST', '/api/reviews', { ip: freshIp(), raw: body }), 400, 'invalid', 'rating');
    });
  }

  const types = [
    ['name as a number', { name: 12345 }, 'name'],
    ['name as an array', { name: ['Test', 'Client'] }, 'name'],
    ['name as an object', { name: { first: 'Test', last: 'Client' } }, 'name'],
    ['phone as a number', { phone: 821234567 }, 'phone'],
    ['service as null', { service: null }, 'service'],
    ['service missing', { service: undefined }, 'service'],
    ['date as a number', { date: 20261212 }, 'date'],
    ['time as a number', { time: 900 }, 'time'],
  ];
  for (const [label, over, field] of types) {
    await check(`booking ${label} → 400`, async () =>
      expectError(await call('POST', '/api/bookings', { ip: freshIp(), json: booking(over) }), 400, 'invalid', field));
  }

  await check('a NUL byte in a booking name is refused or removed', async () => {
    const r = await call('POST', '/api/bookings', { ip: freshIp(), json: booking({ name: `Nul\u0000l Byte ${NAME_TAG}` }) });
    expectStatus(r, [201, 400]);
    if (r.status === 400) return 'refused';
    const mine = (await pendingRequests()).find((x) => x.ref === r.json.ref);
    assert.ok(mine, 'not in the pending list');
    assert.ok(!mine.name.includes('\u0000'), `stored with the NUL: ${JSON.stringify(mine.name)}`);
    return `stored as ${JSON.stringify(mine.name)}`;
  });

  await check('a NUL byte in a review comment is refused or removed', async () => {
    const mark = newMark();
    const out = await postApprovePublish(review({ comment: `Great\u0000 service, truly lovely. ${mark}` }), mark, freshIp());
    expectStatus(out.posted, [201, 400]);
    if (out.posted.status === 400) return 'refused';
    assert.ok(out.pub, 'not visible after approval');
    assert.ok(!out.pub.comment.includes('\u0000'), `stored with the NUL: ${JSON.stringify(out.pub.comment)}`);
    return `stored as ${JSON.stringify(out.pub.comment)}`;
  });

  const lengths = [
    ['bookings', 'an 81-character name', booking({ name: `${'A'.repeat(40)} ${'B'.repeat(40)}` }), 400, 'name'],
    ['bookings', 'a 5000-character name', booking({ name: `${'A'.repeat(2500)} ${'B'.repeat(2499)}` }), 400, 'name'],
    ['bookings', 'an 80-character name', booking({ name: `${'A'.repeat(40)} ${'B'.repeat(39)}` }), 201],
    ['bookings', 'a one-word name', booking({ name: 'Thandi' }), 400, 'name'],
    ['bookings', 'a 16-digit phone', booking({ phone: '0821234567123456' }), 400, 'phone'],
    ['bookings', 'an 8-digit phone', booking({ phone: '08212345' }), 400, 'phone'],
    ['bookings', 'a phone with letters', booking({ phone: '082 CALL ME' }), 400, 'phone'],
    ['reviews', 'a 41-character name', review({ name: 'A'.repeat(41) }), 400, 'name'],
    ['reviews', 'a 1-character name', review({ name: 'A' }), 400, 'name'],
    ['reviews', 'a 501-character comment', review({ comment: 'y'.repeat(501) }), 400, 'comment'],
    ['reviews', 'a 9-character comment', review({ comment: 'Too short' }), 400, 'comment'],
    ['reviews', 'a 500-character comment', review({ comment: `${'z'.repeat(490)} ${newMark()}`.slice(0, 500) }), 201],
    ['reviews', 'a comment with an https:// link', review({ comment: 'Visit https://spam.example for deals' }), 400, 'comment'],
    ['reviews', 'a comment with a www. link', review({ comment: 'Cheap lashes at www.spam.example today' }), 400, 'comment'],
    ['reviews', 'a comment with an http:// link', review({ comment: 'Nice! http://spam.example/x more text' }), 400, 'comment'],
  ];
  for (const [endpoint, label, body, status, field] of lengths) {
    await check(`${endpoint}: ${label} → ${status}`, async () => {
      const r = await call('POST', `/api/${endpoint}`, { ip: freshIp(), json: body });
      if (status === 201) {
        expectStatus(r, 201);
        return '201';
      }
      return expectError(r, status, 'invalid', field);
    });
  }

  await check('admin block with an 81-character label → 400', async () =>
    expectError(await admin('POST', '/api/admin/blocks', {
      json: { date: FX.d4, start: '08:00', end: '09:00', kind: 'closed', label: 'L'.repeat(81) },
    }), 400, 'invalid'));

  await check('zero-width and bidi characters are removed before a review is stored', async () => {
    const mark = newMark();
    const out = await postApprovePublish(
      review({ name: 'Le​rato M.', comment: `Ama​zing‮ service⁦ truly lovely ${mark}` }), mark, freshIp());
    expectStatus(out.posted, [201, 400]);
    if (out.posted.status === 400) return 'refused';
    assert.ok(out.pub, 'not visible after approval');
    assert.equal(out.pub.comment, `Amazing service truly lovely ${mark}`, `came back as ${JSON.stringify(out.pub.comment)}`);
    assert.equal(out.pub.name, 'Lerato M.', `name came back as ${JSON.stringify(out.pub.name)}`);
    return 'removed';
  });

  await check('length is counted after invisible characters are removed', async () =>
    expectError(await call('POST', '/api/reviews', { ip: freshIp(), json: review({ comment: `Good${'​'.repeat(12)} job` }) }), 400, 'invalid', 'comment'));

  await check('comment text is normalised to NFC', async () => {
    const mark = newMark();
    const out = await postApprovePublish(review({ comment: `Café visit was lovely ${mark}` }), mark, freshIp());
    expectStatus(out.posted, 201);
    assert.ok(out.pub, 'not visible after approval');
    assert.equal(out.pub.comment, `Café visit was lovely ${mark}`, `came back as ${JSON.stringify(out.pub.comment)}`);
    return 'composed';
  });

  await check('a "__proto__" key cannot supply a missing field', async () => {
    const body = JSON.stringify({ name: `Proto ${NAME_TAG}`, phone: newPhone(), date: dateAt(50), time: '10:00', company: '', elapsed: 30_000 })
      .replace(/^\{/, '{"__proto__":{"service":"full-glam"},');
    return expectError(await call('POST', '/api/bookings', { ip: freshIp(), raw: body }), 400, 'invalid', 'service');
  });

  await check('"__proto__" and "constructor" keys on login grant nothing', async () => {
    for (const raw of [
      '{"__proto__":{"isAdmin":true,"authenticated":true},"password":"wrong-password-proto"}',
      '{"constructor":{"prototype":{"isAdmin":true}},"password":"wrong-password-ctor"}',
    ]) {
      const r = await call('POST', '/api/admin/login', { ip: freshIp(), raw });
      expectStatus(r, [400, 401]);
      assert.ok(!sessionCookie(r), 'a session cookie was set');
    }
    expectError(await call('GET', '/api/admin/session'), 401, 'unauthorized');
    expectStatus(await call('GET', `/api/availability?month=${monthOf(TODAY)}`), 200);
    return 'still 401 without a cookie; the site still answers';
  });

  await check('extra keys cannot confirm a request or change its length', async () => {
    const date = dateAt(51);
    const r = await call('POST', '/api/bookings', {
      ip: freshIp(),
      json: { ...booking({ name: `Extra ${NAME_TAG}`, date }), status: 'confirmed', minutes: 5, id: 1, kind: 'booking', isAdmin: true },
    });
    expectStatus(r, [201, 400]);
    if (r.status === 400) return 'refused';
    const mine = (await pendingRequests()).find((x) => x.ref === r.json.ref);
    assert.ok(mine, 'not in the pending list (was it confirmed?)');
    assert.equal(mine.minutes, SERVICE_MINUTES, `minutes is ${mine.minutes}`);
    const busy = (await call('GET', `/api/availability?month=${monthOf(date)}`)).json?.busy?.[date];
    assert.ok(!busy, `the day became busy: ${JSON.stringify(busy)}`);
    return 'ignored';
  });

  await check('an extra "status": "approved" key cannot publish a review', async () => {
    const mark = newMark();
    const r = await call('POST', '/api/reviews', {
      ip: freshIp(), json: { ...review({ comment: `Self-approval attempt ${mark}` }), status: 'approved', approved_at: '2026-01-01' },
    });
    expectStatus(r, [201, 400]);
    if (r.status === 400) return 'refused';
    const { all } = await allPublicReviews();
    assert.ok(!all.some((x) => String(x.comment).includes(mark)), 'published without approval');
    assert.ok((await adminReviews('pending')).some((x) => String(x.comment).includes(mark)), 'not in the pending list');
    return 'still pending';
  });

  const year = Number(TODAY.slice(0, 4)) + 1;
  const badTimes = [
    ['an impossible date (30 February)', { date: `${year}-02-30` }, [400]],
    ['a malformed date', { date: `${year}-1-5` }, [400]],
    ['yesterday', { date: addDays(TODAY, -1) }, [400, 409]],
    [`${MAX_DAYS_AHEAD + 1} days ahead`, { date: addDays(TODAY, MAX_DAYS_AHEAD + 1) }, [400, 409]],
    ['400 days ahead', { date: addDays(TODAY, 400) }, [400, 409]],
    ['an off-grid time (09:15)', { date: D, time: '09:15' }, [400, 409]],
    ['before opening (05:30)', { date: D, time: '05:30' }, [400, 409]],
    ['running past closing (17:00 for 90 minutes)', { date: D, time: '17:00' }, [400, 409]],
    ['at closing (18:00)', { date: D, time: '18:00' }, [400, 409]],
    ['24:00', { date: D, time: '24:00' }, [400, 409]],
    ['25:00', { date: D, time: '25:00' }, [400]],
    ['9:00 without the leading zero', { date: D, time: '9:00' }, [400]],
    ['an unknown service', { service: 'not-a-service' }, [400]],
    ['a service id in the wrong case', { service: 'Full-Glam' }, [400]],
  ];
  for (const [label, over, statuses] of badTimes) {
    await check(`booking for ${label} → ${statuses.join(' or ')}`, async () => {
      const r = await call('POST', '/api/bookings', { ip: freshIp(), json: booking(over) });
      return expectError(r, statuses);
    });
  }

  await check('booking inside the minimum notice → refused', async () => {
    let tooSoon = null;
    for (let t = OPEN; t + SERVICE_MINUTES <= CLOSE; t += STEP) if (t < NOW_MIN + MIN_NOTICE) tooSoon = t;
    if (tooSoon === null) return `not testable at ${hhmm(NOW_MIN)} SAST: every slot today is still far enough ahead`;
    return expectError(await call('POST', '/api/bookings', { ip: freshIp(), json: booking({ date: TODAY, time: hhmm(tooSoon) }) }), [400, 409]);
  });

  const busyCases = [
    ['inside a confirmed booking (10:30)', FX.d1, '10:30', 409],
    ['overlapping the start of a confirmed booking (09:00 for 90 minutes)', FX.d1, '09:00', 409],
    ['on a day blocked off (10:00)', FX.d3, '10:00', 409],
    ['right after a confirmed booking (11:30)', FX.d1, '11:30', 201],
  ];
  for (const [label, date, time, status] of busyCases) {
    await check(`booking ${label} → ${status}`, async () => {
      assert.ok(FX.block1 && FX.block3, 'fixture blocks missing (see fixtures)');
      const r = await call('POST', '/api/bookings', { ip: freshIp(), json: booking({ date, time }) });
      if (status === 201) {
        expectStatus(r, 201);
        return '201 (ranges are half-open)';
      }
      return expectError(r, 409, 'taken');
    });
  }

  const cur = monthOf(TODAY);
  for (const m of [cur, addMonths(cur, 12)]) {
    await check(`availability month=${m} → 200`, async () => {
      expectStatus(await call('GET', `/api/availability?month=${m}`), 200);
      return '200';
    });
  }
  const badMonths = [
    ['13 months ahead', addMonths(cur, 13)], ['last month', addMonths(cur, -1)], ['month 13', `${cur.slice(0, 4)}-13`],
    ['month 00', `${cur.slice(0, 4)}-00`], ['a date instead of a month', TODAY], ['an empty month', ''],
  ];
  for (const [label, m] of badMonths) {
    await check(`availability for ${label} → 400`, async () =>
      expectError(await call('GET', `/api/availability?month=${encodeURIComponent(m)}`), 400, 'invalid'));
  }
  await check('availability with no month → 400', async () => expectError(await call('GET', '/api/availability'), 400, 'invalid'));

  for (const p of ['0', '-1', 'abc', '1e3', '99999999999999999999', '2.5', '']) {
    await check(`reviews page=${JSON.stringify(p)} → 400 or a normal page`, async () => {
      const r = await call('GET', `/api/reviews?page=${encodeURIComponent(p)}`);
      expectStatus(r, [200, 400]);
      if (r.status === 200) assertReviewsShape(r.json);
      return String(r.status);
    });
  }

  await check('admin blocks: more than 62 days, or from after to → 400', async () => {
    expectError(await admin('GET', `/api/admin/blocks?from=${dateAt(1)}&to=${dateAt(70)}`), 400, 'invalid');
    expectError(await admin('GET', `/api/admin/blocks?from=${dateAt(10)}&to=${dateAt(5)}`), 400, 'invalid');
    return '400 and 400';
  });

  const badBlocks = [
    ['start after end', { start: '10:00', end: '09:00' }],
    ['an empty range', { start: '10:00', end: '10:00' }],
    ['off the 5-minute grid', { start: '10:03', end: '11:00' }],
    ['an unknown kind', { kind: 'vip' }],
    ['25:00', { end: '25:00' }],
  ];
  for (const [label, over] of badBlocks) {
    await check(`admin block with ${label} → 400`, async () =>
      expectError(await admin('POST', '/api/admin/blocks', {
        json: { date: FX.d4, start: '08:00', end: '09:00', kind: 'closed', label: 'x', ...over },
      }), 400, 'invalid'));
  }
}

async function honeypot() {
  group('honeypot');
  const keys = FX.bookingKeys ?? ['ok', 'ref', 'summary', 'whatsappUrl'];

  const bookingCases = [
    ['a booking with the hidden "company" field filled', { company: 'Acme Spam Ltd' }, [201]],
    ['a booking sent 0.5 s after the form opened', { elapsed: 500 }, [201]],
    ['a booking with no "elapsed" at all', { elapsed: undefined }, [201, 400]],
  ];
  let n = 0;
  for (const [label, over, statuses] of bookingCases) {
    n += 1;
    await check(`${label}: a normal-looking reply, nothing stored`, async () => {
      const name = `Honey ${NAME_TAG} ${'abc'[n - 1]}`;
      const phone = newPhone();
      const r = await call('POST', '/api/bookings', { ip: freshIp(), json: booking({ name, phone, ...over }) });
      expectStatus(r, statuses);
      if (r.status === 201) {
        assert.deepEqual(Object.keys(r.json || {}).sort(), keys, `reply keys ${Object.keys(r.json || {})} differ from a real booking's ${keys}`);
        assert.match(String(r.json.ref), REF_RE, `ref is ${r.json.ref}`);
      }
      const stored = (await pendingRequests()).filter((x) => x.name === name || digits(x.phone) === digits(phone));
      assert.equal(stored.length, 0, `stored as ${stored.map((x) => x.ref).join(', ')}`);
      return `${r.status}, not stored`;
    });
  }

  const reviewCases = [
    ['a review with the hidden "company" field filled', { company: 'Acme Spam Ltd' }],
    ['a review sent 1 s after the form opened', { elapsed: 1000 }],
    ['a review with no "elapsed" at all', { elapsed: undefined }],
  ];
  for (const [label, over] of reviewCases) {
    await check(`${label}: a normal-looking reply, nothing stored`, async () => {
      const mark = newMark();
      const r = await call('POST', '/api/reviews', { ip: freshIp(), json: review({ comment: `Spam bot review ${mark}`, ...over }) });
      expectStatus(r, over.elapsed === undefined && !('company' in over) ? [201, 400] : [201]);
      if (r.status === 201) assert.deepEqual(r.json, { ok: true }, `reply ${snip(r.text)} differs from a real review's { ok: true }`);
      const stored = (await adminReviews('pending')).filter((x) => String(x.comment).includes(mark));
      assert.equal(stored.length, 0, 'stored as a pending review');
      return `${r.status}, not stored`;
    });
  }
}

async function privacy() {
  group('privacy');

  await check('availability shows the confirmed booking and the day off as bare time ranges', async () => {
    const r1 = await call('GET', `/api/availability?month=${monthOf(FX.d1)}`);
    expectStatus(r1, 200);
    const d1 = r1.json?.busy?.[FX.d1] ?? [];
    assert.ok(d1.some(([s, e]) => s <= '10:00' && e >= hhmm(600 + SERVICE_MINUTES)), `busy on ${FX.d1}: ${JSON.stringify(d1)}`);
    const r3 = await call('GET', `/api/availability?month=${monthOf(FX.d3)}`);
    const d3 = r3.json?.busy?.[FX.d3] ?? [];
    assert.ok(d3.some(([s, e]) => s <= hhmm(OPEN) && e >= hhmm(CLOSE)), `busy on ${FX.d3}: ${JSON.stringify(d3)}`);
    return `${FX.d1} ${JSON.stringify(d1)}, ${FX.d3} ${JSON.stringify(d3)}`;
  });

  await check('availability leaks nothing about who booked, what, or why', async () => {
    const months = [...new Set([FX.d1, FX.d2, FX.d3].map(monthOf))];
    const needles = [
      FX.name1, FX.name2, NAME_TAG, FX.phone1, digits(FX.phone1), FX.phone2, digits(FX.phone2), FX.ref1, FX.ref2,
      FX.label3, NONCE, SERVICE, 'Full Glam', 'label', 'phone', 'name', 'service', 'kind', 'closed', 'booking', 'ref', 'pending',
    ].filter(Boolean);
    for (const m of months) {
      const r = await call('GET', `/api/availability?month=${m}`);
      expectStatus(r, 200);
      assert.deepEqual(Object.keys(r.json).sort(), ['busy', 'month', 'now', 'ok', 'today'], `top-level keys: ${Object.keys(r.json)}`);
      for (const [date, ranges] of Object.entries(r.json.busy)) {
        assert.match(date, /^\d{4}-\d{2}-\d{2}$/, `busy key ${date}`);
        assert.ok(Array.isArray(ranges) && ranges.every((p) => Array.isArray(p) && p.length === 2 && p.every((t) => /^\d{2}:\d{2}$/.test(t))),
          `busy on ${date}: ${JSON.stringify(ranges)}`);
      }
      const lower = r.text.toLowerCase();
      for (const needle of needles) assert.ok(!lower.includes(String(needle).toLowerCase()), `${m} contains "${needle}"`);
    }
    return `checked ${months.join(', ')}`;
  });

  await check('a pending request does not make its time busy', async () => {
    const r = await call('GET', `/api/availability?month=${monthOf(FX.d2)}`);
    expectStatus(r, 200);
    const ranges = r.json?.busy?.[FX.d2] ?? [];
    assert.ok(!ranges.some(([s, e]) => s < hhmm(600 + SERVICE_MINUTES) && e > '10:00'), `busy on ${FX.d2}: ${JSON.stringify(ranges)}`);
    return 'free';
  });

  await check('public reviews carry only id, name, rating, comment and date', async () => {
    const { first } = await allPublicReviews(1);
    assert.ok(first.reviews.length > 0, 'no published reviews to inspect');
    for (const rv of first.reviews) {
      assert.deepEqual(Object.keys(rv).sort(), ['comment', 'date', 'id', 'name', 'rating'], `review keys: ${Object.keys(rv)}`);
      assert.match(String(rv.date), /^\d{4}-\d{2}-\d{2}$/, `date ${rv.date}`);
    }
    const { all } = await allPublicReviews();
    assert.ok(!all.some((rv) => String(rv.comment).includes(FX.pendingReviewMark)), 'a pending review is public');
    return `${first.reviews.length} on page 1`;
  });
}

const SECURITY_HEADERS = {
  'x-content-type-options': /^nosniff$/i,
  'referrer-policy': /^strict-origin-when-cross-origin$/i,
  'x-frame-options': /^deny$/i,
  'cross-origin-opener-policy': /^same-origin$/i,
};

function securityHeaderProblems(h) {
  const problems = [];
  for (const [name, re] of Object.entries(SECURITY_HEADERS)) {
    if (!re.test(h.get(name) || '')) problems.push(`${name}: ${h.get(name) ?? 'missing'}`);
  }
  const pp = (h.get('permissions-policy') || '').replace(/\s+/g, '');
  for (const feature of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()']) {
    if (!pp.includes(feature)) problems.push(`permissions-policy lacks ${feature}`);
  }
  problems.push(...cspProblems(h.get('content-security-policy')));
  if (BASE.protocol === 'https:' && !/max-age=\d{7,}/.test(h.get('strict-transport-security') || '')) problems.push('no HSTS over https');
  if (h.get('x-powered-by')) problems.push(`x-powered-by: ${h.get('x-powered-by')}`);
  if (/\d+\.\d+/.test(h.get('server') || '')) problems.push(`server header gives a version: ${h.get('server')}`);
  return problems;
}

const TRAVERSAL = [
  '/..%2fwrangler.toml', '/%2e%2e/wrangler.toml', '/%2e%2e%2fwrangler.toml', '/..%2f..%2fwrangler.toml',
  '/js/..%2f..%2fwrangler.toml', '/js/%2e%2e/%2e%2e/src/index.js', '/%2e%2e%2fsrc%2findex.js', '/..%5cwrangler.toml',
  '/js/../../wrangler.toml', '/admin/../../src/index.js', '/.dev.vars', '/%2edev.vars', '/wrangler.toml', '/src/index.js',
  '/package.json', '/package-lock.json', '/migrations/0001_init.sql', '/API.md', '/README.md', '/.git/config',
  '/node_modules/wrangler/package.json', '/e2e/run.sh', '/.wrangler/',
];
const LEAK_MARKERS = [
  '[[d1_databases]]', 'database_id', 'compatibility_date', 'ADMIN_PASSWORD=', 'export default', 'CREATE TABLE',
  '"devDependencies"', '"lockfileVersion"', 'repositoryformatversion', 'root:x:0:0', '#!/usr/bin/env bash',
  '# OMG booking and reviews API', 'wrangler d1 migrations',
];

async function headers() {
  group('headers');
  const cur = monthOf(TODAY);
  const targets = [
    ['the home page', '/', 200],
    ['a script file', '/js/catalog.js', 200],
    ['an image', '/img/logo.webp', 200],
    ['the admin page', '/admin/', 200],
    ['an API success', `/api/availability?month=${cur}`, 200],
    ['an API error', '/api/availability?month=nope', 400],
    ['a missing page', `/no-such-page-${NONCE}`, 404],
    ['a missing API route', `/api/no-such-route-${NONCE}`, 404],
  ];
  for (const [label, path, status] of targets) {
    await check(`security headers on ${label} (${path})`, async () => {
      const r = await call('GET', path);
      expectStatus(r, status);
      const problems = securityHeaderProblems(r.headers);
      assert.equal(problems.length, 0, problems.join('; '));
      return `${r.status}`;
    });
  }

  await check('/admin/ is noindex and no-store', async () => {
    const r = await call('GET', '/admin/');
    expectStatus(r, 200);
    assert.match(r.headers.get('x-robots-tag') || '', /noindex/i, `x-robots-tag: ${r.headers.get('x-robots-tag')}`);
    assert.match(r.headers.get('x-robots-tag') || '', /nofollow/i, `x-robots-tag: ${r.headers.get('x-robots-tag')}`);
    assert.match(r.headers.get('cache-control') || '', /no-store/i, `cache-control: ${r.headers.get('cache-control')}`);
  });

  await check('/admin without the slash goes nowhere but /admin/', async () => {
    const r = await call('GET', '/admin');
    expectStatus(r, [200, 301, 302, 303, 307, 308]);
    if (r.status >= 300) {
      const to = new URL(r.headers.get('location') || '', BASE);
      assert.equal(to.origin, ORIGIN, `redirects off-site to ${to}`);
      assert.equal(to.pathname, '/admin/', `redirects to ${to.pathname}`);
    }
    return String(r.status);
  });

  await check('API replies are noindex and no-store', async () => {
    const plain = [
      await call('GET', `/api/availability?month=${cur}`),
      await call('GET', '/api/availability?month=nope'),
      await call('GET', `/api/no-such-route-${NONCE}`),
      await admin('GET', '/api/admin/session'),
      // Reviews are not cached either: an approval has to show at once.
      await call('GET', '/api/reviews?page=1'),
    ];
    for (const r of plain) {
      assert.match(r.headers.get('x-robots-tag') || '', /noindex/i, `${r.path}: x-robots-tag ${r.headers.get('x-robots-tag')}`);
      assert.match(r.headers.get('cache-control') || '', /no-store/i, `${r.path}: cache-control ${r.headers.get('cache-control')}`);
    }
  });

  await check('an unknown /api route → JSON 404 not_found', async () =>
    expectError(await call('GET', `/api/no-such-route-${NONCE}`), 404, 'not_found'));

  const methods = [
    ['PUT', '/api/bookings', ['POST'], false],
    ['GET', '/api/bookings', ['POST'], false],
    ['DELETE', '/api/reviews', ['GET', 'POST'], false],
    ['POST', '/api/availability', ['GET'], false],
    ['GET', '/api/admin/login', ['POST'], false],
    ['PATCH', `/api/admin/blocks/${FX.block3?.id ?? 1}`, ['DELETE'], true],
  ];
  for (const [method, path, allow, withSession] of methods) {
    await check(`${method} ${path} → 405 with Allow: ${allow.join(', ')}`, async () => {
      const opts = ['POST', 'PUT', 'PATCH'].includes(method) ? { json: {} } : {};
      const r = withSession ? await admin(method, path, opts) : await call(method, path, opts);
      const detail = expectError(r, 405, 'method_not_allowed');
      const got = (r.headers.get('allow') || '').toUpperCase().split(/\s*,\s*/);
      for (const m of allow) assert.ok(got.includes(m), `Allow: ${r.headers.get('allow')}`);
      return `${detail}, Allow: ${r.headers.get('allow')}`;
    });
  }

  for (const path of TRAVERSAL) {
    await check(`GET ${path} reveals no source or secrets`, async () => {
      const r = await rawHttp({ path, headers: { 'CF-Connecting-IP': freshIp() } });
      assert.ok(r.status !== 0, `no reply${r.timedOut ? ' (timed out)' : ''}`);
      const leaked = LEAK_MARKERS.filter((m) => r.body.includes(m));
      assert.equal(leaked.length, 0, `status ${r.status}, body contains ${leaked.join(', ')}`);
      return String(r.status);
    });
  }
}

async function adminAuth() {
  group('admin');
  const blockBody = { date: FX.d4, start: '08:00', end: '09:00', kind: 'closed', label: 'no session' };
  const routes = [
    ['GET', '/api/admin/session'],
    ['GET', '/api/admin/requests'],
    ['POST', `/api/admin/requests/${FX.id2 ?? 1}/confirm`],
    ['POST', `/api/admin/requests/${FX.id2 ?? 1}/decline`],
    ['GET', `/api/admin/blocks?from=${FX.d1}&to=${FX.d3}`],
    ['POST', '/api/admin/blocks'],
    ['DELETE', `/api/admin/blocks/${FX.block3?.id ?? 1}`],
    ['GET', '/api/admin/reviews?status=pending'],
    ['POST', `/api/admin/reviews/${FX.pendingReviewId ?? 1}/approve`],
    ['DELETE', `/api/admin/reviews/${FX.pendingReviewId ?? 1}`],
    ['GET', '/api/admin/push/key'],
    ['POST', '/api/admin/push/subscribe'],
    ['POST', '/api/admin/push/unsubscribe'],
    ['POST', '/api/admin/push/test'],
    ['GET', '/api/admin/push/latest'],
    ['GET', '/api/admin/site'],
    ['POST', '/api/admin/site/services'],
    ['POST', '/api/admin/site/services/soft-glam'],
    ['DELETE', '/api/admin/site/services/soft-glam'],
    ['POST', '/api/admin/site/services-order'],
    ['POST', '/api/admin/site/text'],
    ['POST', '/api/admin/site/photos'],
    ['POST', '/api/admin/site/photos/1'],
    ['DELETE', '/api/admin/site/photos/1'],
    ['POST', '/api/admin/site/photos-order'],
    ['GET', '/api/admin/calendar-sync'],
    ['POST', '/api/admin/calendar-sync/feed-reset'],
    ['POST', '/api/admin/calendar-sync/import'],
    ['DELETE', '/api/admin/calendar-sync/import'],
    ['POST', '/api/admin/calendar-sync/sync'],
  ];
  for (const [method, path] of routes) {
    await check(`${method} ${path} without a session → 401`, async () =>
      expectError(await call(method, path, method === 'POST' ? { json: blockBody } : {}), 401, 'unauthorized'));
  }
  await check('none of those requests created a block', async () => {
    assert.equal((await adminBlocks(FX.d4, FX.d4)).length, 0, 'a block was created');
  });
  await survival('after the unauthenticated requests');

  await check('POST /api/admin/logout without a session → refused or harmless', async () => {
    const r = await call('POST', '/api/admin/logout', { json: {} });
    expectStatus(r, [200, 401]);
    return String(r.status);
  });

  const tweak = (c) => (c ? c.slice(0, -1) + (c.endsWith('A') ? 'B' : 'A') : `${COOKIE_NAME}=x`);
  const forged = [
    ['a random token', `${COOKIE_NAME}=${randomBytes(32).toString('base64url')}`],
    ['an SQL payload', `${COOKIE_NAME}=' OR '1'='1`],
    ['an empty value', `${COOKIE_NAME}=`],
    ['a 5000-character value', `${COOKIE_NAME}=${'A'.repeat(5000)}`],
    ['the real token under another name', ADMIN.cookie ? ADMIN.cookie.replace(COOKIE_NAME, 'omg_admin') : 'omg_admin=x'],
    ['the real token with its last character changed', tweak(ADMIN.cookie)],
  ];
  for (const [label, cookie] of forged) {
    await check(`a cookie holding ${label} → no session`, async () => {
      const r = await call('GET', '/api/admin/session', { cookie });
      expectStatus(r, [400, 401, 431]);
      return String(r.status);
    });
  }

  let thirdCookie = null;
  await check('login issues a new token rather than adopting one the client sent', async () => {
    const planted = randomBytes(32).toString('base64url');
    const r = await call('POST', '/api/admin/login', { ip: fixedIp('admin', 2), cookie: `${COOKIE_NAME}=${planted}`, json: { password: PASSWORD } });
    expectStatus(r, 200);
    const issued = sessionCookie(r);
    assert.ok(issued, 'no cookie set');
    assert.notEqual(issued, `${COOKIE_NAME}=${planted}`, 'the planted token was kept');
    expectError(await call('GET', '/api/admin/session', { cookie: `${COOKIE_NAME}=${planted}` }), 401, 'unauthorized');
    return 'fresh token';
  });

  await check('the session cookie is __Host-, Secure, HttpOnly, SameSite=Strict, Path=/, at most 14 days', async () => {
    const r = await call('POST', '/api/admin/login', { ip: fixedIp('admin', 3), json: { password: PASSWORD } });
    expectStatus(r, 200);
    const c = setCookies(r).map(parseCookie).find((x) => x.name === COOKIE_NAME);
    assert.ok(c, `no ${COOKIE_NAME} cookie`);
    const a = c.attrs;
    const problems = [];
    if (a.path !== '/') problems.push(`Path=${a.path}`);
    if (!a.secure) problems.push('no Secure');
    if (!a.httponly) problems.push('no HttpOnly');
    if (String(a.samesite).toLowerCase() !== 'strict') problems.push(`SameSite=${a.samesite}`);
    if (a.domain) problems.push(`Domain=${a.domain}`);
    const maxAge = Number(a['max-age']);
    if (!(maxAge > 0 && maxAge <= 1_209_600)) problems.push(`Max-Age=${a['max-age']}`);
    if (c.value.length < 32) problems.push(`token only ${c.value.length} characters`);
    if (r.text.includes(c.value)) problems.push('token also in the reply body');
    if (r.text.includes(PASSWORD)) problems.push('password echoed in the reply');
    assert.equal(problems.length, 0, problems.join(', '));
    thirdCookie = `${c.name}=${c.value}`;
    return `Max-Age=${maxAge}, ${c.value.length}-character token`;
  });

  await check('logout ends the session: the old cookie is refused afterwards', async () => {
    assert.ok(thirdCookie, 'no session from the previous check');
    const ip = fixedIp('admin', 3);
    expectStatus(await call('GET', '/api/admin/session', { cookie: thirdCookie, ip }), 200, 'the session before logout');
    const out = await call('POST', '/api/admin/logout', { cookie: thirdCookie, ip, json: {} });
    expectStatus(out, 200);
    const cleared = setCookies(out).map(parseCookie).find((x) => x.name === COOKIE_NAME);
    const expired = cleared && (cleared.value === '' || Number(cleared.attrs['max-age']) <= 0
      || (cleared.attrs.expires && Date.parse(cleared.attrs.expires) < Date.now()));
    assert.ok(expired, 'logout did not expire the cookie');
    expectError(await call('GET', '/api/admin/session', { cookie: thirdCookie, ip }), 401, 'unauthorized');
    return 'cookie cleared, token dead';
  });

  await check('5 wrong passwords from one address → 401 each, then 429', async () => {
    const ip = fixedIp('admin', 4);
    const replies = [];
    for (let i = 0; i < 6; i += 1) replies.push(await call('POST', '/api/admin/login', { ip, json: { password: `wrong-password-${i}-${NONCE}` } }));
    const statuses = replies.map((r) => r.status);
    assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401], `statuses ${statuses.join(' ')}`);
    expectError(replies[0], 401, 'bad_password');
    expectError(replies[5], 429, 'rate_limited');
    assertRetryAfter(replies[5]);
    return statuses.join(' ');
  });

  await check('after that even the right password from that address is refused (429)', async () => {
    const r = await call('POST', '/api/admin/login', { ip: fixedIp('admin', 4), json: { password: PASSWORD } });
    const detail = expectError(r, 429, 'rate_limited');
    assert.ok(!sessionCookie(r), 'a session cookie was set anyway');
    return detail;
  });

  await check('another address can still log in', async () => {
    const r = await call('POST', '/api/admin/login', { ip: fixedIp('admin', 5), json: { password: PASSWORD } });
    expectStatus(r, 200);
    assert.ok(sessionCookie(r), 'no cookie set');
    return '200';
  });

  await check('the password is compared exactly: no trimming, no case folding', async () => {
    expectError(await call('POST', '/api/admin/login', { ip: freshIp(), json: { password: ` ${PASSWORD} ` } }), 401, 'bad_password');
    const flipped = PASSWORD.toUpperCase() === PASSWORD ? PASSWORD.toLowerCase() : PASSWORD.toUpperCase();
    if (flipped !== PASSWORD) {
      expectError(await call('POST', '/api/admin/login', { ip: freshIp(), json: { password: flipped } }), 401, 'bad_password');
    }
    return 'both refused';
  });

  await check('a password that is not a string grants nothing (["right password"] included)', async () => {
    for (const password of [true, 1, null, [PASSWORD], { $ne: '' }]) {
      const r = await call('POST', '/api/admin/login', { ip: freshIp(), json: { password } });
      expectStatus(r, [400, 401], `password ${JSON.stringify(password)}`);
      assert.ok(!sessionCookie(r), `a session for password ${JSON.stringify(password)}`);
    }
    return 'all refused';
  });

  // Setting a password with a one-time setup code. No code exists in this
  // database, so every attempt must be refused, and none may sign anyone in.
  const SETUP = { code: 'K7QX-M2PA-9RTV-WHJ3', password: `new-password-${NONCE}` };
  await check('setup from another site → 403', async () =>
    expectError(await call('POST', '/api/admin/setup', { ip: freshIp(), origin: 'https://evil.example', json: SETUP }), 403, 'forbidden'));
  for (const [label, body, field] of [
    ['no code', { password: SETUP.password }, 'code'],
    ['a code in the wrong format', { ...SETUP, code: "K7QX' OR 1=1 --" }, 'code'],
    ['a code that is not a string', { ...SETUP, code: ['K7QXM2PA9RTVWHJ3'] }, 'code'],
    ['a password under 12 characters', { ...SETUP, password: 'short pw' }, 'password'],
    ['a password that is not a string', { ...SETUP, password: { $ne: '' } }, 'password'],
  ]) {
    await check(`setup with ${label} → 400`, async () => {
      const r = await call('POST', '/api/admin/setup', { ip: freshIp(), json: body });
      assert.ok(!sessionCookie(r), 'a session cookie was set');
      return expectError(r, 400, 'invalid', field);
    });
  }
  await check('setup with a code nobody made → 403, no session, and the old password still works', async () => {
    const r = await call('POST', '/api/admin/setup', { ip: freshIp(), json: SETUP });
    expectError(r, 403, 'bad_code');
    assert.ok(!sessionCookie(r), 'a session cookie was set');
    expectError(await call('POST', '/api/admin/login', { ip: freshIp(), json: { password: SETUP.password } }), 401, 'bad_password');
    expectStatus(await call('POST', '/api/admin/login', { ip: freshIp(), json: { password: PASSWORD } }), 200, 'the real password');
    return '403 bad_code';
  });
  await check('setup: 5 tries per 15 minutes per address, then 429', async () => {
    const ip = freshIp();
    const statuses = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await call('POST', '/api/admin/setup', { ip, json: { ...SETUP, password: `${SETUP.password}-${i}` } })).status);
    assert.deepEqual(statuses, [403, 403, 403, 403, 403, 429], statuses.join(' '));
    return statuses.join(' ');
  });
}

/**
 * Phone alerts: only push-service addresses are stored (the Worker must never
 * be made to send requests anywhere else), the routes need a session and the
 * site's own Origin, and an alert's text never carries a phone number.
 */
async function alerts() {
  group('alerts');
  const DEVICE = `https://fcm.googleapis.com/fcm/send/e2e-${NONCE}-${'x'.repeat(20)}`;

  await check('the alert key is a P-256 public key, the same every time', async () => {
    const a = await admin('GET', '/api/admin/push/key');
    const b = await admin('GET', '/api/admin/push/key');
    expectStatus(a, 200);
    assert.match(a.json?.publicKey ?? '', /^B[A-Za-z0-9_-]{86}$/, 'a 65-byte uncompressed point, base64url');
    assert.equal(b.json?.publicKey, a.json.publicKey, 'the key changed between calls');
  });

  const refused = [
    ['plain http', DEVICE.replace('https:', 'http:')],
    ['another host', `https://evil.example/fcm/send/${'x'.repeat(30)}`],
    ['a look-alike host', `https://fcm.googleapis.com.evil.example/fcm/send/${'x'.repeat(20)}`],
    ['credentials in the address', DEVICE.replace('https://', 'https://user:pw@')],
    ['a port', DEVICE.replace('fcm.googleapis.com', 'fcm.googleapis.com:8443')],
    ['this site itself', `${ORIGIN}/api/admin/push/test?${'x'.repeat(20)}`],
    ['a local address', `https://127.0.0.1/${'x'.repeat(30)}`],
    ['over 1024 characters', `${DEVICE}${'y'.repeat(1100)}`],
    ['a number', 12345],
    ['missing', undefined],
  ];
  for (const [label, endpoint] of refused) {
    await check(`subscribe with ${label} → 400`, async () =>
      expectError(await admin('POST', '/api/admin/push/subscribe', { json: { endpoint } }), 400, 'invalid', 'endpoint'));
  }

  await check('subscribe from another site → 403', async () =>
    expectError(await admin('POST', '/api/admin/push/subscribe', { origin: 'https://evil.example', json: { endpoint: DEVICE } }), 403, 'forbidden'));

  await check('a push-service address is accepted, and removed again', async () => {
    expectStatus(await admin('POST', '/api/admin/push/subscribe', { json: { endpoint: DEVICE } }), 200);
    expectStatus(await admin('POST', '/api/admin/push/unsubscribe', { json: { endpoint: DEVICE } }), 200);
  });

  await check('a test alert with no devices sends nothing', async () => {
    const r = await admin('POST', '/api/admin/push/test', { json: {} });
    expectStatus(r, 200);
    assert.equal(r.json?.devices, 0, `devices: ${r.json?.devices}`);
    assert.equal(r.json?.sent, 0);
  });

  await check('the alert text has a title and body, and no phone number', async () => {
    const r = await admin('GET', '/api/admin/push/latest');
    expectStatus(r, 200);
    assert.equal(typeof r.json?.title, 'string');
    assert.equal(typeof r.json?.body, 'string');
    assert.ok(!/\d{9,}/.test(`${r.json.title} ${r.json.body}`.replace(/[\s()+-]/g, '')), `a phone number in: ${r.json.body}`);
    for (const phone of [FX.phone1, FX.phone2].filter(Boolean)) {
      assert.ok(!r.json.body.includes(phone), 'a fixture phone number in the alert');
    }
    return `${r.json.title}: ${r.json.body}`;
  });

  await check('test alerts: 429 after 10 an hour', async () => {
    // The check above sent one already.
    const { at, r } = await burstUntil429(() => admin('POST', '/api/admin/push/test', { json: {} }), 12);
    // 10 an hour including the one above; 11 allows for a window starting between them.
    assert.ok(at && at <= 11, `limited at request ${at} of this burst`);
    return expectError(r, 429, 'rate_limited');
  });
  await survival('after the alert checks');
}

/** A photo upload (multipart) as the admin page sends it. */
async function uploadPhoto(fields, files, { origin = ORIGIN, cookie = ADMIN.cookie } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  for (const [k, { bytes, type, name }] of Object.entries(files)) form.append(k, new Blob([bytes], { type }), name);
  const headers = { 'cf-connecting-ip': ADMIN.ip };
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(new URL('/api/admin/site/photos', BASE), { method: 'POST', headers, body: form, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  remember('POST', '/api/admin/site/photos', res.status, res.headers.get('content-type'), text);
  return { status: res.status, headers: res.headers, text, json, method: 'POST', path: '/api/admin/site/photos' };
}

/**
 * The Website tab: what OMG types reaches the public page only as text, the
 * checks hold, uploads take only real JPEG/WebP photos, and /media serves
 * only keys the Worker made.
 */
async function content() {
  group('content');
  const page = async () => {
    const r = await call('GET', '/');
    expectStatus(r, 200, 'GET /');
    return r.text;
  };
  const jsonBlocks = (html) => [...html.matchAll(/<script type="application\/(?:ld\+)?json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const outsideAttributes = (html) => html.replace(/="[^"]*"/g, '=""');
  const EVIL = `Glam "q" <img src=x onerror=alert(1)> ${NONCE}`;
  let created = null;

  await check('a service named with markup is created', async () => {
    const r = await admin('POST', '/api/admin/site/services', { json: { card: 'makeup', name: EVIL, price: 999, minutes: 60, note: '<b>note</b>', level: null, details: null, visible: true } });
    expectStatus(r, 201);
    created = r.json.service;
    assert.match(created.id, /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/, `id ${created.id}`);
    return created.id;
  });

  await check('…and reaches the public page only as text', async () => {
    const html = await page();
    assert.ok(html.includes('Glam &quot;q&quot; &lt;img src=x onerror=alert(1)&gt;'), 'the escaped name is not on the page');
    assert.ok(!/<img src=x onerror/.test(outsideAttributes(html)), 'a raw <img> outside attribute values');
    assert.ok(!html.includes('<b>note</b>'), 'the note was not escaped');
    for (const block of jsonBlocks(html)) assert.ok(!/[<>]/.test(block), 'a raw < or > inside a JSON block');
    assert.ok(html.includes('aria-label="Book Glam &quot;q&quot; &lt;img'), 'quotes not escaped in the Book button label');
    assert.ok(/<meta name="description" content="[^"]*Glam &quot;q&quot;/.test(html), 'quotes not escaped in the page description');
  });

  const badServices = [
    ['price as text', { price: '999' }, 'price'],
    ['a negative price', { price: -5 }, 'price'],
    ['50 minutes', { minutes: 50 }, 'minutes'],
    ['an unknown card', { card: 'nails' }, 'card'],
    ['a 61-character name', { name: 'n'.repeat(61) }, 'name'],
    ['visible as text', { visible: 'yes' }, 'visible'],
  ];
  for (const [label, change, field] of badServices) {
    await check(`service with ${label} → 400 ${field}`, async () =>
      expectError(await admin('POST', '/api/admin/site/services', { json: { card: 'bride', name: 'Test service', price: 100, minutes: 60, visible: true, ...change } }), 400, 'invalid', field));
  }

  for (const path of ["/api/admin/site/services/soft-glam'%20OR%201%3D1", '/api/admin/site/services/..%2F..', '/api/admin/site/services/SOFT-GLAM', '/api/admin/site/photos/1%20OR%201%3D1']) {
    await check(`POST ${path} → 404`, async () =>
      expectError(await admin('POST', path, { json: { card: 'makeup', name: 'x', price: 1, minutes: 60, visible: true, alt: 'xyz' } }), 404, 'not_found'));
  }

  const badText = [
    ['a javascript: Facebook link', { facebook_url: 'javascript:alert(1)' }, 'facebook_url'],
    ['a look-alike Facebook host', { facebook_url: 'https://facebook.com.evil.example/x' }, 'facebook_url'],
    ['a phone number with letters', { phone: '082 ABC 4567' }, 'phone'],
    ['an Instagram link elsewhere', { instagram: 'https://evil.example/omg' }, 'instagram'],
    ['a 3-character welcome line', { tagline: 'Hi!' }, 'tagline'],
  ];
  for (const [label, body, field] of badText) {
    await check(`text with ${label} → 400 ${field}`, async () => expectError(await admin('POST', '/api/admin/site/text', { json: body }), 400, 'invalid', field));
  }

  await check('editing the site from another site → 403', async () =>
    expectError(await admin('POST', '/api/admin/site/text', { origin: 'https://evil.example', json: { tagline: 'Hijacked tagline text' } }), 403, 'forbidden'));

  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(200).fill(7)]);
  const fields = { album: 'looks', alt: `Test photo ${NONCE}`, width: 1440, height: 1800, small_width: 720 };
  const refusedFiles = [
    ['plain text', new TextEncoder().encode('just some text, not a photo at all'), 'text/plain', 'large'],
    ['an SVG with a script', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml', 'large'],
    ['a PNG', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0)]), 'image/png', 'large'],
    ['an HTML page named .jpg', new TextEncoder().encode('<html><script>alert(1)</script></html>'), 'image/jpeg', 'large'],
  ];
  for (const [label, bytes, type, field] of refusedFiles) {
    await check(`upload of ${label} → 400 ${field}`, async () =>
      expectError(await uploadPhoto(fields, { large: { bytes, type, name: 'x.jpg' }, small: { bytes: jpeg, type: 'image/jpeg', name: 's.jpg' } }), 400, 'invalid', field));
  }
  await check('upload sent as JSON → 415', async () =>
    expectError(await admin('POST', '/api/admin/site/photos', { json: fields }), 415, 'unsupported_media_type'));
  await check('upload from another site → 403', async () =>
    expectError(await uploadPhoto(fields, { large: { bytes: jpeg, type: 'image/jpeg', name: 'l.jpg' }, small: { bytes: jpeg, type: 'image/jpeg', name: 's.jpg' } }, { origin: 'https://evil.example' }), 403, 'forbidden'));
  await check('upload with an impossible size → 400', async () =>
    expectError(await uploadPhoto({ ...fields, width: 99999 }, { large: { bytes: jpeg, type: 'image/jpeg', name: 'l.jpg' }, small: { bytes: jpeg, type: 'image/jpeg', name: 's.jpg' } }), 400, 'invalid', 'width'));

  let photo = null;
  await check('a JPEG is accepted and served from /media, as an image only', async () => {
    const r = await uploadPhoto(fields, { large: { bytes: jpeg, type: 'image/jpeg', name: 'l.jpg' }, small: { bytes: jpeg, type: 'image/jpeg', name: 's.jpg' } });
    expectStatus(r, 201);
    photo = r.json.photo;
    assert.match(photo.src, /^\/media\/[a-f0-9]{32}-l\.jpg$/);
    const m = await call('GET', photo.src);
    expectStatus(m, 200, photo.src);
    assert.equal(m.headers.get('content-type'), 'image/jpeg');
    assert.equal(m.headers.get('x-content-type-options'), 'nosniff');
    assert.match(m.headers.get('cache-control') || '', /immutable/);
    assert.ok((await page()).includes(photo.src), 'the photo is not on the page');
  });

  for (const path of ['/media/..%2F..%2Fwrangler.toml', '/media/%2e%2e/src/index.js', `/media/${'a'.repeat(32)}-l.jpg`, '/media/abc.svg', '/media/']) {
    await check(`GET ${path} → 404`, async () => expectStatus(await call('GET', path), 404));
  }
  await check('POST /media/… → 405', async () => expectStatus(await call('POST', photo ? photo.src : '/media/x', { raw: 'x' }), 405));

  await check('the test photo and service are removed again', async () => {
    if (photo) {
      expectStatus(await admin('DELETE', `/api/admin/site/photos/${photo.id}`), 200);
      expectStatus(await call('GET', photo.src), 404, 'deleted photo file');
    }
    if (created) expectStatus(await admin('DELETE', `/api/admin/site/services/${created.id}`), 200);
    const html = await page();
    assert.ok(!html.includes(NONCE), 'test content is still on the page');
  });
  await survival('after the content checks');
}

/** Both ways between the site and OMG's own calendar: the bookings feed, and linking her calendar. */
async function calendarSync() {
  group('calendar');
  let feed = null;
  const feedPath = () => new URL(feed.https).pathname;

  await check('the bookings feed link is this site\'s own, and nothing is linked yet', async () => {
    const r = await admin('GET', '/api/admin/calendar-sync');
    expectStatus(r, 200);
    feed = r.json?.feed;
    assert.ok(String(feed?.https).startsWith(`${ORIGIN}/calendar/`), `feed link ${feed?.https}`);
    assert.match(feedPath(), /^\/calendar\/[a-f0-9]{48}\.ics$/);
    assert.equal(feed.webcal, feed.https.replace(/^https?:/, 'webcal:'));
    assert.equal(r.json.import?.connected, false);
    assert.ok(!('url' in r.json.import), 'a calendar link is never sent back');
  });

  await check('the feed is a calendar with the confirmed booking and the time off', async () => {
    const r = await call('GET', feedPath());
    expectStatus(r, 200);
    assert.equal(r.headers.get('content-type'), 'text/calendar; charset=utf-8');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('x-robots-tag') || '', /noindex/);
    const text = r.text.replace(/\r\n[ \t]/g, '');
    assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n') && text.endsWith('END:VCALENDAR\r\n'), 'not a calendar file');
    assert.ok(text.includes(FX.name1), 'the confirmed booking is missing');
    assert.ok(text.includes(`Phone: ${FX.phone1}`), 'its phone number is missing');
    assert.ok(text.includes(FX.label3), 'the time off is missing');
    assert.ok(!text.includes(FX.name2), 'a request that is still pending is in the feed');
    return `${(text.match(/^BEGIN:VEVENT\r$/gm) || []).length} events`;
  });

  await check('the admin page sees that the feed was collected', async () => {
    const r = await admin('GET', '/api/admin/calendar-sync');
    assert.ok(Date.parse(r.json?.feed?.seenAt) > Date.now() - 180_000, `seenAt ${r.json?.feed?.seenAt}`);
  });

  for (const bad of ['/calendar/x.ics', `/calendar/${'0'.repeat(48)}.ics`, "/calendar/'%20OR%201=1--.ics", '/calendar/', `/calendar/${'a'.repeat(48)}`]) {
    await check(`GET ${bad} → 404`, async () => expectStatus(await call('GET', bad), 404));
  }
  await check('POST to the feed → 405', async () => expectStatus(await call('POST', feedPath(), { raw: 'x' }), 405));

  await check('a new feed link from another site → 403', async () =>
    expectError(await admin('POST', '/api/admin/calendar-sync/feed-reset', { origin: 'https://evil.example', json: {} }), 403, 'forbidden'));
  await check('a new feed link replaces the old one at once', async () => {
    const old = feedPath();
    const r = await admin('POST', '/api/admin/calendar-sync/feed-reset', { json: {} });
    expectStatus(r, 200);
    feed = r.json.feed;
    assert.notEqual(feedPath(), old);
    assert.equal(feed.seenAt, null);
    expectStatus(await call('GET', old), 404, 'the old link');
    expectStatus(await call('GET', feedPath()), 200, 'the new link');
  });

  const refused = [
    ['another host', 'https://evil.example/calendar.ics'],
    ['a look-alike host', 'https://calendar.google.com.evil.example/x.ics'],
    ['this site', `${ORIGIN}/calendar/x.ics`],
    ['a local address', 'https://127.0.0.1/x.ics'],
    ['credentials in it', 'https://user:pw@calendar.google.com/x.ics'],
    ['a port', 'https://calendar.google.com:8443/x.ics'],
    ['javascript:', 'javascript:alert(1)'],
    ['a file path', 'file:///etc/passwd'],
    ['a number', 42],
    ['nothing', undefined],
  ];
  for (const [label, url] of refused) {
    await check(`linking a calendar on ${label} → 400`, async () =>
      expectError(await admin('POST', '/api/admin/calendar-sync/import', { json: { url } }), 400, 'invalid', 'url'));
  }
  await check('linking a calendar from another site → 403', async () =>
    expectError(await admin('POST', '/api/admin/calendar-sync/import', { origin: 'https://evil.example', json: { url: 'https://calendar.google.com/x.ics' } }), 403, 'forbidden'));
  await check('an iCloud link that can\'t be read → 422 with a plain message, and nothing is saved', async () => {
    const r = await admin('POST', '/api/admin/calendar-sync/import', { json: { url: `webcal://p01-caldav.icloud.com/published/2/e2e-${NONCE}` }, timeout: 45_000 });
    expectStatus(r, 422);
    assert.match(r.json?.error ?? '', /^calendar_/);
    assert.ok(r.json.message && !/fetch|error:|exception/i.test(r.json.message), `message: ${r.json.message}`);
    const after = await admin('GET', '/api/admin/calendar-sync');
    assert.equal(after.json?.import?.connected, false);
    return r.json.message;
  });
  await check('"Check now" with nothing linked → 404', async () =>
    expectError(await admin('POST', '/api/admin/calendar-sync/sync', { json: {} }), 404, 'not_connected'));
  await check('unlinking with nothing linked is harmless', async () => {
    const r = await admin('DELETE', '/api/admin/calendar-sync/import');
    expectStatus(r, 200);
    assert.equal(r.json?.import?.connected, false);
  });

  await check('calendar link actions: 429 after 30 an hour', async () => {
    const { at, r } = await burstUntil429(() => admin('POST', '/api/admin/calendar-sync/sync', { json: {} }), 40);
    assert.ok(at && at <= 31, `limited at request ${at} of this burst`);
    return expectError(r, 429, 'rate_limited');
  });
  await check('the feed: 429 after 120 an hour from one address, wrong links included', async () => {
    const ip = freshIp();
    const { at, r } = await burstUntil429(() => call('GET', `/calendar/${'1'.repeat(48)}.ics`, { ip }), 130);
    assert.ok(at && at <= 121, `limited at request ${at}`);
    assert.ok(Number(r.headers.get('retry-after')) > 0, 'no Retry-After');
    expectStatus(await call('GET', feedPath(), { ip: freshIp() }), 200, 'another address');
    return `at ${at}`;
  });
  await survival('after the calendar checks');
}

async function burstUntil429(makeCall, max) {
  for (let i = 1; i <= max; i += 1) {
    const r = await makeCall(i);
    if (r.status === 429) return { at: i, r };
    if (r.status >= 500) throw new Error(`request ${i} → ${r.status}`);
  }
  return { at: null, r: null };
}

async function rateLimits() {
  group('ratelimit');
  const cur = monthOf(TODAY);

  const reads = [
    ['GET /api/availability', 1, () => `/api/availability?month=${cur}`],
    ['GET /api/reviews', 3, () => '/api/reviews?page=1'],
  ];
  for (const [label, n, path] of reads) {
    const ip = fixedIp('ratelimit', n);
    await check(`${label}: 429 after 120 a minute from one address`, async () => {
      const { at, r } = await burstUntil429(() => call('GET', path(), { ip }), 260);
      assert.ok(at, 'no 429 after 260 requests');
      assert.ok(at > 120, `limited after only ${at - 1} requests`);
      expectError(r, 429, 'rate_limited');
      assertRetryAfter(r);
      return `429 on request ${at}`;
    });
    await check(`${label}: another address is unaffected`, async () => {
      expectStatus(await call('GET', path(), { ip: fixedIp('ratelimit', n + 1) }), 200);
      return '200';
    });
  }

  // API.md has two budgets per form: "any attempt" (looser, counts everything,
  // so nobody can hammer it) and "saved" (tighter, counts only what is stored,
  // so a visitor who mistypes a field is not locked out).
  const writes = [
    ['POST /api/bookings', '/api/bookings', 5, 30, 10, () => booking({ date: dateAt(70) }), () => booking({ phone: 'not a phone' }), 'phone'],
    ['POST /api/reviews', '/api/reviews', 3, 20, 20, () => review(), () => review({ rating: 7 }), 'rating'],
  ];
  for (const [label, path, saved, attempts, n, valid, invalid, field] of writes) {
    await check(`${label}: 429 after ${saved} saved from one address`, async () => {
      const ip = fixedIp('ratelimit', n);
      const { at, r } = await burstUntil429(() => call('POST', path, { ip, json: valid() }), saved + 3);
      assert.ok(at, `no 429 after ${saved + 3} valid requests`);
      assert.ok(at > saved, `limited after only ${at - 1} requests`);
      expectError(r, 429, 'rate_limited');
      assertRetryAfter(r);
      return `429 on request ${at}`;
    });
    await check(`${label}: another address is unaffected`, async () => {
      expectStatus(await call('POST', path, { ip: fixedIp('ratelimit', n + 1), json: valid() }), 201);
      return '201';
    });
    await check(`${label}: ${saved + 1} invalid attempts do not use up the saved budget`, async () => {
      const ip = fixedIp('ratelimit', n + 2);
      for (let i = 0; i <= saved; i += 1) expectError(await call('POST', path, { ip, json: invalid() }), 400, 'invalid', field);
      expectStatus(await call('POST', path, { ip, json: valid() }), 201, 'a valid request after the mistakes');
      return '201 after the mistakes';
    });
    await check(`${label}: 429 after ${attempts} attempts an hour from one address, invalid ones included`, async () => {
      const ip = fixedIp('ratelimit', n + 3);
      const { at, r } = await burstUntil429(() => call('POST', path, { ip, json: invalid() }), attempts + 10);
      assert.ok(at, `no 429 after ${attempts + 10} invalid attempts`);
      assert.ok(at > attempts, `limited after only ${at - 1} attempts`);
      expectError(r, 429, 'rate_limited');
      assertRetryAfter(r);
      return `429 on attempt ${at}`;
    });
  }

  let cookie = null;
  await check('other admin routes: 429 after 300 a minute from one address', async () => {
    const ip = fixedIp('ratelimit', 9);
    const login = await call('POST', '/api/admin/login', { ip, json: { password: PASSWORD } });
    expectStatus(login, 200, 'a separate login for this check');
    cookie = sessionCookie(login);
    assert.ok(cookie, 'no cookie set');
    const { at, r } = await burstUntil429(() => call('GET', '/api/admin/session', { ip, cookie }), 420);
    assert.ok(at, 'no 429 after 420 requests');
    assert.ok(at > 300, `limited after only ${at - 1} requests`);
    expectError(r, 429, 'rate_limited');
    assertRetryAfter(r);
    return `429 on request ${at}`;
  });
  await check('other admin routes: another address is unaffected', async () => {
    expectStatus(await admin('GET', '/api/admin/session'), 200);
    return '200';
  });
}

async function runWide() {
  group('global');

  await check('no reply in this run was a 5xx', async () => {
    const bad = seen.filter((x) => x.status >= 500);
    assert.equal(bad.length, 0, bad.slice(0, 5).map((x) => `${x.method} ${x.path} → ${x.status}`).join('; '));
    return `${seen.length} replies`;
  });

  await check('no error body leaked internals (stack traces, SQL, file paths, parser text)', async () => {
    const LEAKS = [
      /\bat\s+[\w$.<>]+\s+\(/, /\.(?:js|ts|mjs):\d+:\d+/, /\/src\//, /\bD1_[A-Z_]+/,
      /SQLITE_|sqlite_master|no such table|syntax error/i, /\b(?:TypeError|ReferenceError|RangeError)\b/,
      /Unexpected token|in JSON at position|is not valid JSON/,
    ];
    const hits = [];
    for (const x of seen) {
      // Raw-socket replies are the traversal probes; LEAK_MARKERS already
      // covered them, and a 404 that echoes "/src/..." back is not a leak.
      if (x.status < 400 || x.raw) continue;
      const re = LEAKS.find((l) => l.test(x.text));
      if (re) hits.push(`${x.method} ${x.path} (${x.status}) matches ${re}`);
    }
    assert.equal(hits.length, 0, hits.slice(0, 3).join('; '));
    return `${seen.filter((x) => x.status >= 400).length} error bodies scanned`;
  });

  await check('every /api reply was JSON', async () => {
    const bad = seen.filter((x) => !x.raw && x.path.startsWith('/api/') && !/^application\/json\b/i.test(x.type));
    assert.equal(bad.length, 0, bad.slice(0, 3).map((x) => `${x.method} ${x.path} → ${x.status} ${x.type || 'no type'}`).join('; '));
  });
}

async function caps() {
  group('caps');
  const avail = await call('GET', `/api/availability?month=${monthOf(sastNow().date)}`);
  if (avail.json?.today) {
    TODAY = avail.json.today;
    NOW_MIN = toMin(avail.json.now);
  }

  await check('bookings: the 300-a-day cap eventually refuses even a fresh address', async () => {
    let created = 0;
    for (let n = 1; n <= 110; n += 1) {
      const ip = ipFor('caps', n);
      for (let k = 0; k < 4; k += 1) { // stays under the per-address limit of 5
        const r = await call('POST', '/api/bookings', { ip, json: booking({ name: `Cap ${NAME_TAG}`, date: dateAt(80) }) });
        if (r.status === 201) {
          created += 1;
          continue;
        }
        if (r.status === 429) {
          expectError(r, 429, 'rate_limited');
          assertRetryAfter(r);
          expectError(await call('POST', '/api/bookings', { ip: ipFor('caps', 900), json: booking({ date: dateAt(80) }) }), 429, 'rate_limited');
          return `refused after ${created} more today, from an address that had sent ${k}; a fresh address is refused too`;
        }
        throw new Error(`unexpected ${r.status} after ${created} bookings: ${snip(r.text)}`);
      }
    }
    throw new Error(`no cap after ${created} bookings from 110 addresses`);
  });

  await check('reviews: the 100-a-day cap eventually refuses even a fresh address', async () => {
    let created = 0;
    for (let n = 200; n <= 330; n += 1) {
      const ip = ipFor('caps', n);
      for (let k = 0; k < 2; k += 1) { // stays under the per-address limit of 3
        const r = await call('POST', '/api/reviews', { ip, json: review() });
        if (r.status === 201) {
          created += 1;
          continue;
        }
        if (r.status === 429) {
          expectError(r, 429, 'rate_limited');
          assertRetryAfter(r);
          expectError(await call('POST', '/api/reviews', { ip: ipFor('caps', 901), json: review() }), 429, 'rate_limited');
          return `refused after ${created} more today, from an address that had sent ${k}; a fresh address is refused too`;
        }
        throw new Error(`unexpected ${r.status} after ${created} reviews: ${snip(r.text)}`);
      }
    }
    throw new Error(`no cap after ${created} reviews from 131 addresses`);
  });

  await check('login: 30 failures an hour lock everyone out, the right password included', async () => {
    let failures = 0;
    for (let n = 400; n <= 420; n += 1) {
      const ip = ipFor('caps', n);
      for (let k = 0; k < 4; k += 1) { // stays under the per-address limit of 5
        const r = await call('POST', '/api/admin/login', { ip, json: { password: `wrong-${n}-${k}-${NONCE}` } });
        if (r.status === 401) {
          failures += 1;
          continue;
        }
        if (r.status === 429) {
          expectError(r, 429, 'rate_limited');
          const right = await call('POST', '/api/admin/login', { ip: ipFor('caps', 902), json: { password: PASSWORD } });
          expectError(right, 429, 'rate_limited');
          assert.ok(!sessionCookie(right), 'a session cookie was set anyway');
          return `locked after ${failures} more failures, from an address that had sent ${k}; the right password is refused too`;
        }
        throw new Error(`unexpected ${r.status} after ${failures} failures: ${snip(r.text)}`);
      }
    }
    throw new Error(`no lockout after ${failures} failures from 21 addresses`);
  });
}

// ================================================================ main

async function main() {
  console.log(`OMG security checks, phase ${PHASE}, against ${ORIGIN} (run ${RUN}, nonce ${NONCE})`);
  if (PHASE === 'caps') {
    await caps();
  } else {
    await preflight();
    await fixtures();
    await sqli();
    await xss();
    await csrf();
    await input();
    await honeypot();
    await privacy();
    await headers();
    await adminAuth();
    await alerts();
    await content();
    await calendarSync();
    await rateLimits();
  }
  await runWide();

  const failed = results.filter((r) => !r.ok);
  const byGroup = {};
  for (const r of results) {
    byGroup[r.group] ??= { pass: 0, fail: 0 };
    byGroup[r.group][r.ok ? 'pass' : 'fail'] += 1;
  }
  console.log('\n== summary');
  for (const [g, c] of Object.entries(byGroup)) console.log(`${g.padEnd(10)} ${c.pass} passed${c.fail ? `, ${c.fail} FAILED` : ''}`);
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`\n${results.length - failed.length - skipped} passed, ${failed.length} failed${skipped ? `, ${skipped} skipped on local dev` : ''}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('The suite itself crashed:', err);
  process.exit(1);
});
