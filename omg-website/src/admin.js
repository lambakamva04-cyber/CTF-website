// The admin API: sign-in, booking requests, the calendar and reviews.

import { UTC_OFFSET_MINUTES } from '../public/js/catalog.js';
import { addDays, daysBetween, nowInZone, overlaps, toHHMM, toMinutes } from '../public/js/slots.js';
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

async function conflictsWith(env, date, start, end, exceptId = null) {
  const { results } = await env.DB.prepare('SELECT id, start, end, kind, label FROM blocks WHERE date = ?1 ORDER BY start').bind(date).all();
  return results
    .filter((b) => b.id !== exceptId && overlaps(start, end, toMinutes(b.start), toMinutes(b.end)))
    .map((b) => ({ id: b.id, start: b.start, end: b.end, kind: b.kind, label: b.label ?? null }));
}

const overlapError = (conflicts) =>
  new HttpError(409, 'overlap', 'That overlaps something already in the calendar.', { conflicts });

// ---- sign-in -----------------------------------------------------------------

export async function login({ env, request, client }) {
  await enforce(env, 'login', client, 'Too many sign-in attempts. Please wait 15 minutes and try again.');
  const secret = env.ADMIN_PASSWORD;
  if (typeof secret !== 'string' || secret.length < 12) {
    throw new HttpError(503, 'not_configured', 'The admin password has not been set up yet.');
  }
  const lock = await peek(env, 'loginFailAll', 'all');
  if (!lock.allowed) {
    throw new HttpError(429, 'rate_limited', 'Sign-in is paused after too many wrong passwords. Please try again later.', {
      retryAfter: lock.retryAfter,
    });
  }
  const body = await readJson(request);
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length > 256 || !(await sameSecret(password, secret))) {
    await hit(env, 'loginFailAll', 'all');
    throw new HttpError(401, 'bad_password', 'That password is not right.');
  }
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?1').bind(now),
    env.DB.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?1, ?2)').bind(await sha256Hex(token), now + SESSION_MS),
  ]);
  return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=${token}; ${COOKIE_ATTRS}; Max-Age=${SESSION_MS / 1000}` });
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
  const { results } = await ctx.env.DB.prepare(
    'SELECT b.id, b.date, b.start, b.end, b.kind, b.label, r.ref, r.name, r.phone, r.service, s.name AS service_name ' +
      'FROM blocks b LEFT JOIN booking_requests r ON r.id = b.request_id LEFT JOIN services s ON s.id = r.service ' +
      'WHERE b.date >= ?1 AND b.date <= ?2 ORDER BY b.date, b.start, b.id',
  )
    .bind(from, to)
    .all();
  return json({ ok: true, blocks: results.map(blockOut) });
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
