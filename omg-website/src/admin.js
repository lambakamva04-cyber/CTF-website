// The admin API: sign-in, booking requests, the calendar and reviews.

import { UTC_OFFSET_MINUTES } from '../public/js/catalog.js';
import { addDays, daysBetween, formatRanges, isDate, nowInZone, overlaps, toHHMM, toMinutes } from '../public/js/slots.js';
import { busyOn, externalBusy } from './calendar-busy.js';
import { HttpError, invalid, json, notFound, readJson } from './http.js';
import { enforce, hit, peek, sha256Hex } from './ratelimit.js';
import { blockTime, dateValue, label as noteText } from './validate.js';

const COOKIE = '__Host-omg_admin';
const SESSION_MS = 14 * 86_400_000;
const COOKIE_ATTRS = 'Path=/; Secure; HttpOnly; SameSite=Strict';
const encoder = new TextEncoder();

const unauthorized = () => new HttpError(401, 'unauthorized', 'Please sign in again.');

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const fromBase64url = (text) =>
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)), (c) => c.charCodeAt(0));

function sessionToken(request) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) {
      const value = rest.join('=');
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
  }
  return null;
}

/** Constant-time comparison: both sides are hashed to the same length first. */
async function sameSecret(a, b) {
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

/** Every admin route except login: rate limit, then a valid session. */
export async function guard({ env, request, client }) {
  await enforce(env, 'admin', client);
  const token = sessionToken(request);
  if (!token) throw unauthorized();
  const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?1').bind(await sha256Hex(token)).first();
  if (!row || row.expires_at <= Date.now()) throw unauthorized();
}

const idParam = (params) => Number(params[0]);

function blockOut(row) {
  return {
    id: row.id,
    date: row.date,
    start: row.start,
    end: row.end,
    kind: row.kind,
    label: row.label ?? null,
    ref: row.ref ?? null,
    name: row.name ?? null,
    phone: row.phone ?? null,
    service: row.service ?? null,
    serviceName: row.service_name ?? null,
  };
}

/** What [start, end) on `date` overlaps: bookings and time off here, and busy times in OMG's own calendar. */
async function conflictsWith(env, date, start, end, exceptId = null) {
  const [{ results }, external] = await Promise.all([
    env.DB.prepare('SELECT id, start, end, kind, label FROM blocks WHERE date = ?1 ORDER BY start').bind(date).all(),
    externalBusy(env),
  ]);
  const here = results
    .filter((b) => b.id !== exceptId && overlaps(start, end, toMinutes(b.start), toMinutes(b.end)))
    .map((b) => ({ id: b.id, start: b.start, end: b.end, kind: b.kind, label: b.label ?? null }));
  const theirs = busyOn(external, date)
    .filter(([s, e]) => overlaps(start, end, s, e))
    .map(([s, e]) => ({ id: null, start: toHHMM(s), end: toHHMM(e), kind: 'calendar', label: null }));
  return [...here, ...theirs].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
}

const overlapError = (conflicts) =>
  new HttpError(409, 'overlap', 'That overlaps something already in the calendar.', { conflicts });

// ---- sign-in -----------------------------------------------------------------

// ---- the admin password ------------------------------------------------------
//
// OMG sets the password herself on the admin page, with a one-time setup code.
// It is kept only as a PBKDF2 hash in settings ('admin_password'). A setup code
// is made by whoever runs the site (`npm run admin:setup-code`, or straight in
// the database): only its SHA-256 and an expiry are stored ('admin_setup'), and
// it works once. The ADMIN_PASSWORD secret, if set, is used until a password
// has been set on the page.

/** ~5 ms of CPU: well inside the free plan's 10 ms a request. Stored with each hash, so it can be raised later. */
export const PBKDF2_ITERATIONS = 20_000;
/** 16 characters nobody can misread (no 0/O, 1/I/L): about 79 random bits. */
export const SETUP_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{16}$/;
export const SETUP_CODE_MS = 24 * 3_600_000;
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 256;

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

/** A password → what is stored: never the password itself. */
export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { alg: 'pbkdf2-sha256', iter: iterations, salt: base64url(salt), hash: base64url(await pbkdf2(password, salt, iterations)) };
}

/** True only for the password that made `record`; anything damaged or unexpected is false. */
export async function verifyPassword(password, record) {
  try {
    if (!record || record.alg !== 'pbkdf2-sha256' || !Number.isInteger(record.iter) || record.iter < 1000 || record.iter > 100_000) return false;
    const expected = fromBase64url(record.hash);
    const actual = await pbkdf2(password, fromBase64url(record.salt), record.iter);
    return expected.length === actual.length && crypto.subtle.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** "k7qx m2pa-9rtv whj3" → "K7QXM2PA9RTVWHJ3"; anything else → ''. */
export function setupCode(value) {
  const code = typeof value === 'string' ? value.toUpperCase().replace(/[\s-]/g, '') : '';
  return SETUP_CODE.test(code) ? code : '';
}

async function savedJson(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind(key).first();
  if (!row) return { row: null, value: null };
  try {
    return { row, value: JSON.parse(row.value) };
  } catch {
    return { row, value: null };
  }
}

async function failedTry(env, status, code, message, extra) {
  await hit(env, 'loginFailAll', 'all');
  throw new HttpError(status, code, message, extra);
}

async function loginLock(env) {
  const lock = await peek(env, 'loginFailAll', 'all');
  if (!lock.allowed) {
    throw new HttpError(429, 'rate_limited', 'Sign-in is paused after too many wrong tries. Please try again later.', {
      retryAfter: lock.retryAfter,
    });
  }
}

/** A new session for this browser, after `first` (more statements in the same batch). */
async function startSession(env, first = []) {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.batch([
    ...first,
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?1').bind(now),
    env.DB.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?1, ?2)').bind(await sha256Hex(token), now + SESSION_MS),
  ]);
  return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=${token}; ${COOKIE_ATTRS}; Max-Age=${SESSION_MS / 1000}` });
}

export async function login({ env, request, client }) {
  await enforce(env, 'login', client, 'Too many sign-in attempts. Please wait 15 minutes and try again.');
  const stored = (await savedJson(env, 'admin_password')).value;
  const secret = env.ADMIN_PASSWORD;
  const hasSecret = typeof secret === 'string' && secret.length >= MIN_PASSWORD;
  if (!stored && !hasSecret) {
    throw new HttpError(503, 'not_configured', 'No admin password has been set yet. Set one with a setup code.');
  }
  await loginLock(env);
  const body = await readJson(request);
  const password = typeof body.password === 'string' ? body.password : '';
  const right = password.length <= MAX_PASSWORD && (stored ? await verifyPassword(password, stored) : await sameSecret(password, secret));
  if (!right) await failedTry(env, 401, 'bad_password', 'That password is not right.');
  return startSession(env);
}

/**
 * POST /api/admin/setup { code, password }: sets the admin password with a
 * one-time setup code, and signs this browser in. Every other device is
 * signed out. Rate limited with sign-in: 5 tries per 15 minutes per address,
 * and wrong codes count towards pausing sign-in for everyone.
 */
export async function setup({ env, request, client }) {
  await enforce(env, 'login', client, 'Too many attempts. Please wait 15 minutes and try again.');
  await loginLock(env);
  const body = await readJson(request);
  const code = setupCode(body.code);
  if (!code) throw invalid('code', 'Enter the setup code exactly as you were given it.');
  const password = typeof body.password === 'string' ? body.password : '';
  if ([...password].length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw invalid('password', `Choose a password of at least ${MIN_PASSWORD} characters.`);
  }
  const { row, value: saved } = await savedJson(env, 'admin_setup');
  const valid = Boolean(saved) && typeof saved.hash === 'string' && Number(saved.expires) > Date.now()
    && (await sameSecret(await sha256Hex(code), saved.hash));
  const refused = "That setup code isn't right, or it has expired. Ask for a new one.";
  if (!valid) await failedTry(env, 403, 'bad_code', refused);
  // Used up here, so two requests with one code can't both set a password.
  const claimed = await env.DB.prepare("DELETE FROM settings WHERE key = 'admin_setup' AND value = ?1").bind(row.value).run();
  if (!claimed.meta.changes) await failedTry(env, 403, 'bad_code', refused);
  const record = { ...(await hashPassword(password)), setAt: Date.now() };
  return startSession(env, [
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('admin_password', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(JSON.stringify(record)),
    env.DB.prepare('DELETE FROM sessions'),
  ]);
}

export async function logout({ env, request, client }) {
  await enforce(env, 'admin', client);
  const token = sessionToken(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256Hex(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0` });
}

export async function session(ctx) {
  await guard(ctx);
  const row = await ctx.env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM booking_requests WHERE status = 'pending') AS requests, " +
      "(SELECT COUNT(*) FROM reviews WHERE status = 'pending') AS reviews",
  ).first();
  return json({ ok: true, pending: { requests: row.requests, reviews: row.reviews } });
}

// ---- booking requests --------------------------------------------------------

export async function listRequests(ctx) {
  await guard(ctx);
  const { results } = await ctx.env.DB.prepare(
    'SELECT r.id, r.ref, r.name, r.phone, r.service, s.name AS service_name, s.price AS service_price, r.date, r.start, r.minutes, r.created_at ' +
      "FROM booking_requests r LEFT JOIN services s ON s.id = r.service WHERE r.status = 'pending' " +
      'ORDER BY r.date, r.start, r.id LIMIT 500',
  ).all();
  return json({
    ok: true,
    requests: results.map((r) => {
      return {
        id: r.id,
        ref: r.ref,
        name: r.name,
        phone: r.phone,
        service: r.service,
        serviceName: r.service_name ?? r.service,
        price: r.service_price ?? null,
        date: r.date,
        time: r.start,
        minutes: r.minutes,
        createdAt: new Date(r.created_at).toISOString(),
      };
    }),
  });
}

export async function confirmRequest(ctx) {
  await guard(ctx);
  const { env, request, params } = ctx;
  const body = await readJson(request, { optional: true });
  const req = await env.DB.prepare("SELECT * FROM booking_requests WHERE id = ?1 AND status = 'pending'").bind(idParam(params)).first();
  if (!req) throw notFound('That request is no longer waiting.');

  let minutes = req.minutes;
  if (body.minutes !== undefined) {
    if (!Number.isInteger(body.minutes) || body.minutes < 5 || body.minutes > 720 || body.minutes % 5 !== 0) {
      throw invalid('minutes', 'Use a length from 5 minutes to 12 hours, in 5-minute steps.');
    }
    minutes = body.minutes;
  }
  const start = toMinutes(req.start);
  const end = start + minutes;
  if (end > 1440) throw invalid('minutes', 'That would run past midnight.');

  const conflicts = await conflictsWith(env, req.date, start, end);
  if (conflicts.length && body.force !== true) throw overlapError(conflicts);

  const now = Date.now();
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO blocks (date, start, end, kind, label, request_id, created_at) VALUES (?1, ?2, ?3, 'booking', ?4, ?5, ?6) RETURNING id",
    ).bind(req.date, req.start, toHHMM(end), req.name, req.id, now),
    env.DB.prepare("UPDATE booking_requests SET status = 'confirmed' WHERE id = ?1").bind(req.id),
  ]);
  const id = inserted.results[0].id;
  return json({
    ok: true,
    block: blockOut({ id, date: req.date, start: req.start, end: toHHMM(end), kind: 'booking', label: req.name, ref: req.ref, name: req.name, phone: req.phone, service: req.service }),
  });
}

export async function declineRequest(ctx) {
  await guard(ctx);
  const result = await ctx.env.DB.prepare("DELETE FROM booking_requests WHERE id = ?1 AND status = 'pending'").bind(idParam(ctx.params)).run();
  if (!result.meta.changes) throw notFound('That request is no longer waiting.');
  return json({ ok: true });
}

// ---- calendar blocks ---------------------------------------------------------

export async function listBlocks(ctx) {
  await guard(ctx);
  const from = dateValue(ctx.url.searchParams.get('from'), 'from');
  const to = dateValue(ctx.url.searchParams.get('to'), 'to');
  if (to < from || daysBetween(from, to) > 62) throw invalid('to', 'Show at most 62 days at a time.');
  const [{ results }, external] = await Promise.all([
    ctx.env.DB.prepare(
      'SELECT b.id, b.date, b.start, b.end, b.kind, b.label, r.ref, r.name, r.phone, r.service, s.name AS service_name ' +
        'FROM blocks b LEFT JOIN booking_requests r ON r.id = b.request_id LEFT JOIN services s ON s.id = r.service ' +
        'WHERE b.date >= ?1 AND b.date <= ?2 ORDER BY b.date, b.start, b.id',
    )
      .bind(from, to)
      .all(),
    externalBusy(ctx.env),
  ]);
  // Busy times from OMG's own calendar, shown alongside but not editable here.
  const busy = {};
  for (const date of Object.keys(external).sort()) {
    if (date < from || date > to || !isDate(date)) continue;
    const ranges = busyOn(external, date);
    if (ranges.length) busy[date] = formatRanges(ranges);
  }
  return json({ ok: true, blocks: results.map(blockOut), external: busy });
}

export async function createBlock(ctx) {
  await guard(ctx);
  const body = await readJson(ctx.request);
  const date = dateValue(body.date);
  const today = nowInZone(UTC_OFFSET_MINUTES).date;
  if (date < addDays(today, -31) || date > addDays(today, 400)) throw invalid('date', 'Pick a date within the next year.');
  const start = blockTime(body.start, 'start');
  const end = blockTime(body.end, 'end');
  if (start === '24:00' || toMinutes(end) <= toMinutes(start)) throw invalid('end', 'The end must be after the start.');
  if (body.kind !== 'booking' && body.kind !== 'closed') throw invalid('kind', 'Choose Booking or Time off.');
  const note = noteText(body.label);

  const conflicts = await conflictsWith(ctx.env, date, toMinutes(start), toMinutes(end));
  if (conflicts.length && body.force !== true) throw overlapError(conflicts);

  const row = await ctx.env.DB.prepare(
    'INSERT INTO blocks (date, start, end, kind, label, request_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6) RETURNING id',
  )
    .bind(date, start, end, body.kind, note, Date.now())
    .first();
  return json({ ok: true, block: blockOut({ id: row.id, date, start, end, kind: body.kind, label: note }) }, 201);
}

export async function deleteBlock(ctx) {
  await guard(ctx);
  const id = idParam(ctx.params);
  const block = await ctx.env.DB.prepare('SELECT request_id FROM blocks WHERE id = ?1').bind(id).first();
  if (!block) throw notFound('That is no longer in the calendar.');
  // A cancelled booking takes the client's details with it.
  const statements = [ctx.env.DB.prepare('DELETE FROM blocks WHERE id = ?1').bind(id)];
  if (block.request_id !== null) {
    statements.push(ctx.env.DB.prepare('DELETE FROM booking_requests WHERE id = ?1').bind(block.request_id));
  }
  await ctx.env.DB.batch(statements);
  return json({ ok: true });
}

// ---- reviews -----------------------------------------------------------------

export async function listReviews(ctx) {
  await guard(ctx);
  const status = ctx.url.searchParams.get('status');
  if (status !== 'pending' && status !== 'approved') throw invalid('status', 'Choose pending or approved.');
  const { results } = await ctx.env.DB.prepare(
    'SELECT id, name, rating, comment, status, created_at FROM reviews WHERE status = ?1 ORDER BY created_at DESC, id DESC LIMIT 500',
  )
    .bind(status)
    .all();
  return json({
    ok: true,
    reviews: results.map((r) => ({ id: r.id, name: r.name, rating: r.rating, comment: r.comment, status: r.status, createdAt: new Date(r.created_at).toISOString() })),
  });
}

export async function approveReview(ctx) {
  await guard(ctx);
  const result = await ctx.env.DB.prepare("UPDATE reviews SET status = 'approved', approved_at = ?1 WHERE id = ?2 AND status = 'pending'")
    .bind(Date.now(), idParam(ctx.params))
    .run();
  if (!result.meta.changes) throw notFound('That review is no longer waiting.');
  return json({ ok: true });
}

export async function deleteReview(ctx) {
  await guard(ctx);
  const result = await ctx.env.DB.prepare('DELETE FROM reviews WHERE id = ?1').bind(idParam(ctx.params)).run();
  if (!result.meta.changes) throw notFound('That review no longer exists.');
  return json({ ok: true });
}
