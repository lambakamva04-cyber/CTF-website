// Request limits: fixed-window counters in D1.
//
// Visitors are identified by a salted SHA-256 of their IP, never the IP
// itself. The salt is 32 random bytes the Worker creates once and keeps in the
// settings table. Cloudflare sets CF-Connecting-IP at the edge, so a client
// cannot choose its own.

import { HttpError } from './http.js';

/** Every limit, in one place. */
export const RULES = {
  read: { limit: 120, windowMs: 60_000 },
  // Every attempt counts against the *Try budgets, so nobody can hammer the
  // forms. Only requests that are actually saved count against booking and
  // review, so a visitor who mistypes is not locked out.
  bookingTry: { limit: 30, windowMs: 3_600_000 },
  booking: { limit: 5, windowMs: 3_600_000 },
  bookingAll: { limit: 300, windowMs: 86_400_000 },
  reviewTry: { limit: 20, windowMs: 3_600_000 },
  review: { limit: 3, windowMs: 86_400_000 },
  reviewAll: { limit: 100, windowMs: 86_400_000 },
  login: { limit: 5, windowMs: 900_000 },
  loginFailAll: { limit: 30, windowMs: 3_600_000 },
  admin: { limit: 300, windowMs: 60_000 },
  pushTest: { limit: 10, windowMs: 3_600_000 },
  siteEdit: { limit: 300, windowMs: 3_600_000 },
  upload: { limit: 60, windowMs: 3_600_000 },
  // Connecting, reading or unlinking OMG's own calendar (each reaches out to it).
  calendarSync: { limit: 30, windowMs: 3_600_000 },
  // Her calendar app collecting the bookings feed; wrong links count too.
  calendarFeed: { limit: 120, windowMs: 3_600_000 },
};

const encoder = new TextEncoder();

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let saltPromise;

function ipSalt(env) {
  if (!saltPromise) {
    saltPromise = (async () => {
      // INSERT OR IGNORE then read: if two isolates race, both end up with the winner's salt.
      await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('ip_salt', ?1)").bind(randomHex(32)).run();
      const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'ip_salt'").first();
      return row.value;
    })().catch((error) => {
      saltPromise = undefined;
      throw error;
    });
  }
  return saltPromise;
}

/** Who is making the request, as a salted hash of their IP. */
export async function clientId(env, request) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  return sha256Hex(`${await ipSalt(env)}|${ip}`);
}

function windowFor(name, now) {
  const { limit, windowMs } = RULES[name];
  const start = Math.floor(now / windowMs) * windowMs;
  return { limit, key: `${name}:${start}`, expiresAt: start + windowMs, retryAfter: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
}

/**
 * Counts one request against `subject` under rule `name`. A single upsert, so
 * two requests at the same moment cannot both read the old count.
 */
export async function hit(env, name, subject, now = Date.now()) {
  const w = windowFor(name, now);
  const row = await env.DB.prepare(
    'INSERT INTO rate_limits (key, count, expires_at) VALUES (?1, 1, ?2) ' +
      'ON CONFLICT (key) DO UPDATE SET count = count + 1 RETURNING count',
  )
    .bind(`${w.key}:${subject}`, w.expiresAt)
    .first();
  const count = row ? row.count : 1;
  return { allowed: count <= w.limit, retryAfter: w.retryAfter };
}

/** Whether the budget still has room, without spending any of it. */
export async function peek(env, name, subject, now = Date.now()) {
  const w = windowFor(name, now);
  const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?1').bind(`${w.key}:${subject}`).first();
  return { allowed: (row ? row.count : 0) < w.limit, retryAfter: w.retryAfter };
}

/** Counts one request and refuses it with 429 once the budget is spent. */
export async function enforce(env, name, subject, message = 'Too many requests. Please wait a little and try again.') {
  const result = await hit(env, name, subject);
  if (!result.allowed) throw new HttpError(429, 'rate_limited', message, { retryAfter: result.retryAfter });
}
