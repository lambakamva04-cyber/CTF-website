// Phone alerts: a Web Push to OMG's devices for every new booking request and
// review, so none sits unseen until someone happens to open the admin page.
//
// The push carries no data at all. It only wakes the admin page's service
// worker, which then asks GET /api/admin/push/latest (with OMG's sign-in
// cookie) what to show. So no client's details ever pass through Google's or
// Apple's push servers, and no payload encryption is needed: only a VAPID key
// pair, which the Worker creates once and keeps in the settings table.

import { isDate, weekday } from '../public/js/slots.js';
import { guard } from './admin.js';
import { invalid, json, readJson } from './http.js';
import { enforce } from './ratelimit.js';

/** Alerts describe something that happened in the last this-many ms. */
export const ALERT_WINDOW_MS = 15 * 60_000;
/** Devices kept per site; the oldest is dropped beyond this. */
const MAX_DEVICES = 10;
/** How long a push service should keep trying to deliver an alert. */
const TTL_SECONDS = 24 * 3600;

const encoder = new TextEncoder();
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The browsers' own push services. A subscription must point at one of these,
 * so the Worker can never be made to send requests anywhere else.
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, // Chrome, Edge on Android, Samsung Internet, Opera
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^(?:[a-z0-9-]+\.)*push\.apple\.com$/, // Safari: iPhone (home-screen app), iPad, Mac
  /^(?:[a-z0-9-]+\.)*notify\.windows\.com$/, // Edge on Windows
];

export function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The push address from a subscription, if it is one we will send to. */
export function pushEndpoint(value) {
  const refuse = () => invalid('endpoint', 'This browser gave an alert address that cannot be used.');
  if (typeof value !== 'string' || value.length < 20 || value.length > 1024) throw refuse();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw refuse();
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !PUSH_HOSTS.some((re) => re.test(url.hostname))) {
    throw refuse();
  }
  return value;
}

const cache = new WeakMap();

/**
 * The site's VAPID key pair: created on first use, kept in `settings`, and
 * the same from then on (a new pair would silently break every device's
 * subscription). Concurrent first uses agree on one pair via INSERT OR IGNORE.
 */
export function vapidKeys(env) {
  let keys = cache.get(env.DB);
  if (!keys) {
    keys = (async () => {
      const read = () => env.DB.prepare("SELECT value FROM settings WHERE key = 'vapid'").first();
      let row = await read();
      if (!row) {
        const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        const value = JSON.stringify({
          publicKey: base64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
          privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
        });
        await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid', ?1)").bind(value).run();
        row = await read();
      }
      const { publicKey, privateJwk } = JSON.parse(row.value);
      const privateKey = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      return { publicKey, privateKey };
    })();
    keys.catch(() => cache.delete(env.DB));
    cache.set(env.DB, keys);
  }
  return keys;
}

/** A VAPID token (an ES256 JWT) for one push service, valid for 12 hours. */
export async function vapidJwt(privateKey, audience, subject, nowMs = Date.now()) {
  const part = (value) => base64url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: audience, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject })}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, encoder.encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

/**
 * Wakes every subscribed device. Addresses the push service says are gone
 * (404, 410) are deleted. Returns how many devices accepted the alert.
 */
export async function notifyAdmins(env, origin, fetchImpl = fetch) {
  const { results } = await env.DB.prepare('SELECT endpoint FROM push_subscriptions').all();
  if (!results.length) return { devices: 0, sent: 0, removed: 0 };
  const keys = await vapidKeys(env);
  const subject = origin.startsWith('https://') ? origin : 'https://localhost';
  let sent = 0;
  const gone = [];
  await Promise.all(results.map(async ({ endpoint }) => {
    try {
      const jwt = await vapidJwt(keys.privateKey, new URL(endpoint).origin, subject);
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { authorization: `vapid t=${jwt}, k=${keys.publicKey}`, ttl: String(TTL_SECONDS), urgency: 'high', topic: 'omg-admin' },
        body: '',
      });
      if (res.status === 404 || res.status === 410) gone.push(endpoint);
      else if (res.ok) sent += 1;
      else console.warn('push_refused', res.status);
    } catch (error) {
      console.warn('push_failed', String(error && error.message));
    }
  }));
  if (gone.length) {
    await env.DB.batch(gone.map((endpoint) => env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(endpoint)));
  }
  return { devices: results.length, sent, removed: gone.length };
}

/** Sends the alerts after the response, so the visitor never waits on them. */
export function alertInBackground({ env, url, waitUntil }) {
  if (!waitUntil) return;
  waitUntil(notifyAdmins(env, url.origin).catch((error) => console.error('push_notify_failed', String(error && error.message))));
}

/** "Sat 12 Dec" */
function shortDay(date) {
  if (!isDate(date)) return String(date ?? '');
  const [, m, d] = date.split('-').map(Number);
  return `${WEEKDAYS[weekday(date)]} ${d} ${MONTHS[m - 1]}`;
}

const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || 'Someone';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * What an alert says. Describes the newest of: the latest pending booking
 * request, the latest pending review, a test alert. Only things from the last
 * ALERT_WINDOW_MS count; otherwise it says what is waiting.
 */
export function alertText({ booking, review, testAt, pending }, now = Date.now()) {
  const fresh = (at) => Number.isFinite(at) && at <= now + 60_000 && now - at <= ALERT_WINDOW_MS;
  const events = [
    booking && fresh(booking.created_at) && { kind: 'booking', at: booking.created_at },
    review && fresh(review.created_at) && { kind: 'review', at: review.created_at },
    fresh(testAt) && { kind: 'test', at: testAt },
  ].filter(Boolean).sort((a, b) => b.at - a.at);
  const newest = events[0];
  if (newest && newest.kind === 'booking') {
    return {
      title: 'New booking request',
      body: `${firstName(booking.name)} · ${booking.service_name || 'a service'} · ${shortDay(booking.date)} at ${booking.start}`,
      tag: `booking-${booking.id}`,
    };
  }
  if (newest && newest.kind === 'review') {
    const comment = [...String(review.comment)];
    const quote = comment.length > 90 ? `${comment.slice(0, 89).join('').trimEnd()}…` : comment.join('');
    return {
      title: 'New review to approve',
      body: `${'★'.repeat(review.rating)}${'☆'.repeat(Math.max(0, 5 - review.rating))} ${firstName(review.name)}: “${quote}”`,
      tag: `review-${review.id}`,
    };
  }
  if (newest && newest.kind === 'test') {
    return {
      title: 'Alerts are working',
      body: 'This device will alert you like this for every new booking request and review.',
      tag: 'test',
    };
  }
  const requests = Number(pending && pending.requests) || 0;
  const reviews = Number(pending && pending.reviews) || 0;
  const waiting = [requests && plural(requests, 'booking request'), reviews && plural(reviews, 'review')].filter(Boolean);
  return {
    title: 'OMG – Oh! My Glam',
    body: waiting.length ? `${waiting.join(' and ')} waiting for you.` : 'Open the admin page to see what is new.',
    tag: 'waiting',
  };
}

// ---------------------------------------------------------------- admin routes

/** GET /api/admin/push/key: the public key a browser subscribes with. */
export async function key(ctx) {
  await guard(ctx);
  const { publicKey } = await vapidKeys(ctx.env);
  return json({ ok: true, publicKey });
}

/** POST /api/admin/push/subscribe { endpoint } */
export async function subscribe(ctx) {
  await guard(ctx);
  const body = await readJson(ctx.request);
  const endpoint = pushEndpoint(body.endpoint);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      'INSERT INTO push_subscriptions (endpoint, created_at) VALUES (?1, ?2) ON CONFLICT (endpoint) DO UPDATE SET created_at = excluded.created_at',
    ).bind(endpoint, Date.now()),
    ctx.env.DB.prepare(
      'DELETE FROM push_subscriptions WHERE endpoint NOT IN (SELECT endpoint FROM push_subscriptions ORDER BY created_at DESC LIMIT ?1)',
    ).bind(MAX_DEVICES),
  ]);
  return json({ ok: true });
}

/** POST /api/admin/push/unsubscribe { endpoint } */
export async function unsubscribe(ctx) {
  await guard(ctx);
  const body = await readJson(ctx.request);
  if (typeof body.endpoint !== 'string' || body.endpoint.length > 1024) throw invalid('endpoint', 'Nothing to turn off.');
  await ctx.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(body.endpoint).run();
  return json({ ok: true });
}

/** POST /api/admin/push/test: an alert to every device, now. */
export async function test(ctx) {
  await guard(ctx);
  await enforce(ctx.env, 'pushTest', ctx.client, 'That is a lot of test alerts. Please wait a while before sending another.');
  await ctx.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('push_test_at', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(String(Date.now())).run();
  const result = await notifyAdmins(ctx.env, ctx.url.origin);
  return json({ ok: true, devices: result.devices, sent: result.sent });
}

/** GET /api/admin/push/latest: what the alert that just arrived should say. */
export async function latest(ctx) {
  await guard(ctx);
  const db = ctx.env.DB;
  const [booking, review, test, counts] = await db.batch([
    db.prepare(
      'SELECT r.id, r.name, r.service, s.name AS service_name, r.date, r.start, r.created_at FROM booking_requests r '
      + "LEFT JOIN services s ON s.id = r.service WHERE r.status = 'pending' ORDER BY r.created_at DESC, r.id DESC LIMIT 1",
    ),
    db.prepare("SELECT id, name, rating, comment, created_at FROM reviews WHERE status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1"),
    db.prepare("SELECT value FROM settings WHERE key = 'push_test_at'"),
    db.prepare(
      "SELECT (SELECT COUNT(*) FROM booking_requests WHERE status = 'pending') AS requests, (SELECT COUNT(*) FROM reviews WHERE status = 'pending') AS reviews",
    ),
  ]);
  const text = alertText({
    booking: booking.results[0],
    review: review.results[0],
    testAt: test.results[0] ? Number(test.results[0].value) : undefined,
    pending: counts.results[0],
  });
  return json({ ok: true, ...text });
}
