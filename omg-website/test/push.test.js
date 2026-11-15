// Phone alerts (src/push.js): which addresses are allowed, the VAPID token,
// the stored key pair, sending, and what an alert says. Runs against a real
// SQLite database built from migrations/, through a small D1-style wrapper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ALERT_WINDOW_MS, alertText, base64url, notifyAdmins, pushEndpoint, vapidJwt, vapidKeys } from '../src/push.js';

/** The parts of the D1 API the Worker uses, over node:sqlite. */
function d1(db) {
  const exec = (sql, args) => (/^\s*SELECT/i.test(sql) ? { results: db.prepare(sql).all(...args) } : (db.prepare(sql).run(...args), { results: [] }));
  const statement = (sql, args = []) => ({
    sql,
    args,
    bind: (...values) => statement(sql, values),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => exec(s.sql, s.args));
        db.exec('COMMIT');
        return out;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  return { db, env: { DB: d1(db) } };
}

const fromB64url = (s) => Uint8Array.from(Buffer.from(s, 'base64url'));
const json64 = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

test('base64url has no padding and uses the URL-safe alphabet', () => {
  assert.equal(base64url(new Uint8Array([251, 255, 191])), '-_-_');
  assert.equal(base64url(new Uint8Array([1])), 'AQ');
});

test('alerts are only sent to the browsers\' own push services', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc123def456ghi789',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABkZ2',
    'https://web.push.apple.com/QGhs7sJ3kQ-xyz',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
  ]) assert.equal(pushEndpoint(ok), ok);
  for (const bad of [
    'http://fcm.googleapis.com/fcm/send/abc123def456',
    'https://fcm.googleapis.com.evil.example/fcm/send/abc',
    'https://evil.example/fcm.googleapis.com/abcdefgh',
    'https://user:pw@fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/fcm/send/abcdef',
    'https://evilpush.apple.com/abcdefghijklmnop',
    'https://127.0.0.1/abcdefghijklmnopqrstu',
    'javascript:alert(1)//fcm.googleapis.com/x',
    `https://fcm.googleapis.com/fcm/send/${'a'.repeat(1100)}`,
    'https://x.io/', 123, null, undefined, ['https://fcm.googleapis.com/fcm/send/abc123def456'],
  ]) {
    assert.throws(() => pushEndpoint(bad), (e) => e.status === 400 && e.extra.field === 'endpoint', String(bad).slice(0, 60));
  }
});

test('the site\'s key pair is made once, kept, and agreed on by concurrent first uses', async () => {
  const { db, env } = freshDb();
  const [a, b] = await Promise.all([vapidKeys(env), vapidKeys(env)]);
  assert.equal(a.publicKey, b.publicKey);
  assert.equal(fromB64url(a.publicKey).length, 65, 'an uncompressed P-256 point');
  assert.equal(fromB64url(a.publicKey)[0], 4);
  const again = await vapidKeys({ DB: d1(db) }); // a fresh isolate reads the stored pair
  assert.equal(again.publicKey, a.publicKey);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'vapid'").get().n, 1);
});

test('the VAPID token is an ES256 JWT that the public key verifies', async () => {
  const { env } = freshDb();
  const keys = await vapidKeys(env);
  const now = Date.UTC(2026, 11, 12, 7, 0, 0);
  const jwt = await vapidJwt(keys.privateKey, 'https://fcm.googleapis.com', 'https://omg.example', now);
  const [header, claims, signature] = jwt.split('.');
  assert.deepEqual(json64(header), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(json64(claims), { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'https://omg.example' });
  const publicKey = await crypto.subtle.importKey('raw', fromB64url(keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, fromB64url(signature), new TextEncoder().encode(`${header}.${claims}`));
  assert.ok(valid, 'signature verifies');
});

test('every device is woken with an empty push, and gone ones are dropped', async () => {
  const { db, env } = freshDb();
  const A = 'https://fcm.googleapis.com/fcm/send/device-a-123456';
  const B = 'https://updates.push.services.mozilla.com/wpush/v2/device-b';
  const C = 'https://web.push.apple.com/device-c-123456789';
  for (const e of [A, B, C]) db.prepare('INSERT INTO push_subscriptions (endpoint, created_at) VALUES (?1, ?2)').run(e, 1);
  const calls = [];
  const fakeFetch = async (endpoint, init) => {
    calls.push({ endpoint, init });
    if (endpoint === A) return new Response(null, { status: 201 });
    if (endpoint === B) return new Response(null, { status: 410 });
    throw new Error('network down');
  };
  const result = await notifyAdmins(env, 'https://omg.example', fakeFetch);
  assert.deepEqual(result, { devices: 3, sent: 1, removed: 1 });
  assert.deepEqual(db.prepare('SELECT endpoint FROM push_subscriptions ORDER BY endpoint').all().map((r) => r.endpoint), [A, C].sort());
  const { publicKey } = await vapidKeys(env);
  for (const { endpoint, init } of calls) {
    assert.equal(init.method, 'POST');
    assert.equal(init.body, '', 'the push carries no data');
    assert.equal(init.headers.ttl, '86400');
    assert.equal(init.headers.urgency, 'high');
    const [, token, key] = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(init.headers.authorization) || [];
    assert.ok(token, `authorization header: ${init.headers.authorization}`);
    assert.equal(key, publicKey);
    assert.equal(json64(token.split('.')[1]).aud, new URL(endpoint).origin);
  }
});

test('with no devices nothing is sent and no key pair is made', async () => {
  const { db, env } = freshDb();
  let called = false;
  const result = await notifyAdmins(env, 'https://omg.example', async () => { called = true; return new Response(null, { status: 201 }); });
  assert.deepEqual(result, { devices: 0, sent: 0, removed: 0 });
  assert.equal(called, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'vapid'").get().n, 0);
});

test('what an alert says', () => {
  const now = Date.UTC(2026, 11, 10, 8, 0, 0);
  const booking = { id: 7, name: 'Thandi Mokoena', phone: '082 123 4567', service: 'full-glam', date: '2026-12-12', start: '09:00', created_at: now - 60_000 };
  const review = { id: 3, name: 'Lerato M.', rating: 4, comment: `Lovely service, ${'so good '.repeat(20)}`, created_at: now - 120_000 };

  const b = alertText({ booking, review, pending: { requests: 2, reviews: 1 } }, now);
  assert.equal(b.title, 'New booking request');
  assert.equal(b.body, 'Thandi · Full Glam · Sat 12 Dec at 09:00');
  assert.equal(b.tag, 'booking-7');
  assert.ok(!b.body.includes('4567'), 'never the phone number');

  const r = alertText({ booking: { ...booking, created_at: now - 300_000 }, review, pending: {} }, now);
  assert.equal(r.title, 'New review to approve');
  assert.match(r.body, /^★★★★☆ Lerato: “Lovely service, so good/);
  assert.ok([...r.body].length < 110, 'long comments are shortened');

  const t = alertText({ booking, review, testAt: now - 1000, pending: {} }, now);
  assert.equal(t.title, 'Alerts are working');

  const stale = alertText({ booking: { ...booking, created_at: now - ALERT_WINDOW_MS - 1 }, pending: { requests: 3, reviews: 1 } }, now);
  assert.equal(stale.body, '3 booking requests and 1 review waiting for you.');
  const future = alertText({ booking: { ...booking, created_at: now + 10 * 60_000 }, pending: { requests: 1 } }, now);
  assert.equal(future.body, '1 booking request waiting for you.', 'a clock far ahead is not "new"');
  assert.equal(alertText({ pending: {} }, now).body, 'Open the admin page to see what is new.');
});
