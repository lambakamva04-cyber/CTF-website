// The admin password (src/admin.js): set on the admin page with a one-time
// setup code, kept only as a PBKDF2 hash, and the ADMIN_PASSWORD secret as the
// fallback until then. Runs against a real SQLite database built from
// migrations/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, timingSafeEqual } from 'node:crypto';
import * as admin from '../src/admin.js';
import { freshDb } from './d1.js';

// Workers have crypto.subtle.timingSafeEqual; Node has the same thing elsewhere.
if (!crypto.subtle.timingSafeEqual) crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

const CODE = 'K7QXM2PA9RTVWHJ3';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const post = (path, body) => new Request(`https://omg.example${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://omg.example' }, body: JSON.stringify(body),
});
let ip = 0;
const call = (handler, env, path, body, client = `c${(ip += 1)}`) =>
  handler({ env, client, request: post(path, body) }).then((r) => r, (e) => e);
const giveCode = (db, code = CODE, expires = Date.now() + 3_600_000) =>
  db.prepare("INSERT INTO settings (key, value) VALUES ('admin_setup', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify({ hash: sha(code), expires }));
const setting = (db, key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
const failures = (db) => db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE key LIKE 'loginFailAll:%'").get().n;

test('passwords are stored as salted PBKDF2 hashes and checked exactly', async () => {
  const record = await admin.hashPassword('correct horse battery');
  assert.equal(record.alg, 'pbkdf2-sha256');
  assert.equal(record.iter, admin.PBKDF2_ITERATIONS);
  assert.ok(!JSON.stringify(record).includes('correct horse'), 'never the password itself');
  assert.equal(await admin.verifyPassword('correct horse battery', record), true);
  assert.equal(await admin.verifyPassword('correct horse batterY', record), false);
  assert.equal(await admin.verifyPassword('', record), false);
  const again = await admin.hashPassword('correct horse battery');
  assert.notEqual(again.hash, record.hash, 'a new salt every time');
  for (const bad of [null, {}, { ...record, alg: 'md5' }, { ...record, iter: 10 }, { ...record, iter: 1e7 }, { ...record, hash: '!!' }, { ...record, salt: 5 }]) {
    assert.equal(await admin.verifyPassword('correct horse battery', bad), false, JSON.stringify(bad).slice(0, 40));
  }
});

test('setup codes: letters and digits nobody misreads, dashes and spaces allowed', () => {
  assert.equal(admin.setupCode('k7qx-m2pa-9rtv-whj3'), CODE);
  assert.equal(admin.setupCode(' K7QX M2PA 9RTV WHJ3 '), CODE);
  for (const bad of ['', 'K7QXM2PA9RTVWHJ', 'K7QXM2PA9RTVWHJ3X', 'K7QXM2PA9RTVWHJ0', 'O7QXM2PA9RTVWHJ3', "K7QX' OR 1=1 --", null, 42]) {
    assert.equal(admin.setupCode(bad), '', String(bad));
  }
});

test('with no password anywhere, sign-in says so (the page then asks for a setup code)', async () => {
  const { env } = freshDb();
  const r = await call(admin.login, env, '/api/admin/login', { password: 'anything at all' });
  assert.equal(r.status, 503);
  assert.equal(r.code, 'not_configured');
  const short = await call(admin.login, { ...env, ADMIN_PASSWORD: 'too short' }, '/api/admin/login', { password: 'too short' });
  assert.equal(short.status, 503, 'a secret under 12 characters does not count');
});

test('a setup code sets the password, signs in, works once, and signs other devices out', async () => {
  const { db, env } = freshDb();
  db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').run('old-device', Date.now() + 60_000);
  giveCode(db);
  const ok = await call(admin.setup, env, '/api/admin/setup', { code: 'k7qx-m2pa-9rtv-whj3', password: 'glam glam glam 2026' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /^__Host-omg_admin=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=1209600$/);
  assert.equal(setting(db, 'admin_setup'), undefined, 'the code is used up');
  const stored = JSON.parse(setting(db, 'admin_password'));
  assert.ok(!setting(db, 'admin_password').includes('glam glam'), 'only the hash is stored');
  assert.equal(await admin.verifyPassword('glam glam glam 2026', stored), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1, 'the old device is signed out; this browser is signed in');

  const reuse = await call(admin.setup, env, '/api/admin/setup', { code: CODE, password: 'someone else 12345' });
  assert.equal(reuse.status, 403);
  assert.equal(reuse.code, 'bad_code');

  const login = await call(admin.login, env, '/api/admin/login', { password: 'glam glam glam 2026' });
  assert.equal(login.status, 200);
  const wrong = await call(admin.login, env, '/api/admin/login', { password: 'glam glam glam 2025' });
  assert.equal(wrong.status, 401);
});

test('a password set on the page replaces the secret', async () => {
  const { db, env } = freshDb();
  const withSecret = { ...env, ADMIN_PASSWORD: 'the old secret password' };
  assert.equal((await call(admin.login, withSecret, '/api/admin/login', { password: 'the old secret password' })).status, 200);
  giveCode(db);
  assert.equal((await call(admin.setup, withSecret, '/api/admin/setup', { code: CODE, password: 'a brand new password' })).status, 200);
  assert.equal((await call(admin.login, withSecret, '/api/admin/login', { password: 'the old secret password' })).status, 401);
  assert.equal((await call(admin.login, withSecret, '/api/admin/login', { password: 'a brand new password' })).status, 200);
});

test('wrong, expired or missing codes are refused and counted; a short password keeps the code', async () => {
  const { db, env } = freshDb();
  const body = (over = {}) => ({ code: CODE, password: 'long enough password', ...over });
  const noCode = await call(admin.setup, env, '/api/admin/setup', body());
  assert.equal(noCode.status, 403, 'no code has been made');
  giveCode(db, CODE, Date.now() - 1000);
  assert.equal((await call(admin.setup, env, '/api/admin/setup', body())).status, 403, 'expired');
  giveCode(db);
  assert.equal((await call(admin.setup, env, '/api/admin/setup', body({ code: 'K7QXM2PA9RTVWHJ4' }))).status, 403, 'another code');
  assert.equal(failures(db), 3, 'each wrong code counts towards pausing sign-in');

  const bad = await call(admin.setup, env, '/api/admin/setup', body({ code: 'not a code' }));
  assert.equal(bad.status, 400);
  assert.equal(bad.extra.field, 'code');
  const short = await call(admin.setup, env, '/api/admin/setup', body({ password: 'eleven char' }));
  assert.equal(short.status, 400);
  assert.equal(short.extra.field, 'password');
  assert.ok(setting(db, 'admin_setup'), 'a mistyped password does not use up the code');
  assert.equal((await call(admin.setup, env, '/api/admin/setup', body())).status, 200);
});

test('one code, two requests at once: only one sets the password', async () => {
  const { db, env } = freshDb();
  giveCode(db);
  const results = await Promise.all([
    call(admin.setup, env, '/api/admin/setup', { code: CODE, password: 'first password here' }),
    call(admin.setup, env, '/api/admin/setup', { code: CODE, password: 'second password here' }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 403]);
  const stored = JSON.parse(setting(db, 'admin_password'));
  const winner = results[0].status === 200 ? 'first password here' : 'second password here';
  assert.equal(await admin.verifyPassword(winner, stored), true);
});

test('setup is rate limited like sign-in, and paused with it', async () => {
  const { db, env } = freshDb();
  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await call(admin.setup, env, '/api/admin/setup', { code: CODE, password: 'long enough password' }, 'same-address')).status);
  assert.deepEqual(statuses, [403, 403, 403, 403, 403, 429], '5 tries per 15 minutes per address');
  db.prepare("INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 30, ?) ON CONFLICT (key) DO UPDATE SET count = 30").run(`loginFailAll:${Math.floor(Date.now() / 3_600_000) * 3_600_000}:all`, Date.now() + 3_600_000);
  giveCode(db);
  const paused = await call(admin.setup, env, '/api/admin/setup', { code: CODE, password: 'long enough password' });
  assert.equal(paused.status, 429, 'after 30 wrong tries in an hour, even a right code waits');
});
