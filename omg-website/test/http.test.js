// Request bodies, origin checks, error shapes and security headers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, checkOrigin, errorResponse, json, readJson } from '../src/http.js';
import { securityHeaders, withSecurityHeaders } from '../src/security.js';
import { newRef } from '../src/bookings.js';
import worker from '../src/index.js';

const post = (body, headers = { 'content-type': 'application/json' }) => new Request('https://omg.example/api/x', { method: 'POST', body, headers });
const status = async (promise) => { try { await promise; return 0; } catch (e) { return e.status; } };

test('readJson accepts a JSON object and nothing else', async () => {
  assert.deepEqual(await readJson(post('{"a":1}')), { a: 1 });
  assert.equal(await status(readJson(post('[1,2]'))), 400);
  assert.equal(await status(readJson(post('null'))), 400);
  assert.equal(await status(readJson(post('"text"'))), 400);
  assert.equal(await status(readJson(post('{bad json'))), 400);
  assert.equal(await status(readJson(post('{"a":1}', { 'content-type': 'text/plain' }))), 415);
  assert.equal(await status(readJson(post('a=1', { 'content-type': 'application/x-www-form-urlencoded' }))), 415);
  assert.equal(await status(readJson(post(JSON.stringify({ a: 'x'.repeat(9000) })))), 413);
});

test('readJson: optional bodies, prototype keys, invalid UTF-8', async () => {
  assert.deepEqual(await readJson(new Request('https://omg.example/', { method: 'POST' }), { optional: true }), {});
  const proto = await readJson(post('{"__proto__":{"admin":true}}'));
  assert.equal({}.admin, undefined);
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  const badUtf8 = new Request('https://omg.example/', { method: 'POST', body: new Uint8Array([0x7b, 0xff, 0x7d]), headers: { 'content-type': 'application/json' } });
  assert.equal(await status(readJson(badUtf8)), 400);
});

test('state-changing requests must come from the site itself', () => {
  const url = new URL('https://omg.example/api/bookings');
  const req = (origin) => new Request(url, { method: 'POST', headers: origin ? { origin } : {} });
  assert.doesNotThrow(() => checkOrigin(req('https://omg.example'), url));
  for (const bad of [null, 'https://evil.example', 'null', 'https://omg.example.evil.example', 'http://omg.example']) {
    assert.throws(() => checkOrigin(req(bad), url), (e) => e.status === 403);
  }
});

test('errors are JSON, carry Retry-After, and never leak internals', async () => {
  const limited = errorResponse(new HttpError(429, 'rate_limited', 'Slow down.', { retryAfter: 42 }));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '42');
  assert.deepEqual(await limited.json(), { ok: false, error: 'rate_limited', message: 'Slow down.', retryAfter: 42 });
  const original = console.error;
  console.error = () => {};
  const crash = errorResponse(new Error('SQLITE_ERROR near "DROP": secret detail'));
  console.error = original;
  const body = await crash.text();
  assert.equal(crash.status, 500);
  assert.ok(!body.includes('SQLITE') && !body.includes('secret'));
  const allow = errorResponse(new HttpError(405, 'method_not_allowed', 'No.', { allow: 'GET' }));
  assert.equal(allow.headers.get('allow'), 'GET');
  assert.ok(!(await allow.json()).allow);
});

test('security headers on every response', () => {
  const page = securityHeaders(new URL('https://omg.example/'));
  assert.match(page['content-security-policy'], /script-src 'self'(;|$)/);
  assert.match(page['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(page['content-security-policy'], /upgrade-insecure-requests/);
  assert.equal(page['x-frame-options'], 'DENY');
  assert.equal(page['x-content-type-options'], 'nosniff');
  assert.equal(page['strict-transport-security'], 'max-age=31536000');
  assert.equal(page['x-robots-tag'], undefined);
  const local = securityHeaders(new URL('http://127.0.0.1:8787/'));
  assert.ok(!local['content-security-policy'].includes('upgrade-insecure-requests'));
  assert.equal(local['strict-transport-security'], undefined);
  const adminPage = securityHeaders(new URL('https://omg.example/admin/'));
  assert.equal(adminPage['cache-control'], 'no-store');
  assert.equal(adminPage['x-robots-tag'], 'noindex, nofollow');
  assert.equal(securityHeaders(new URL('https://omg.example/api/reviews'))['x-robots-tag'], 'noindex, nofollow');
  assert.equal(securityHeaders(new URL('https://omg.example/administrator'))['x-robots-tag'], undefined);
});

test('withSecurityHeaders keeps status and body, caches images', async () => {
  const out = withSecurityHeaders(json({ ok: true }, 201), new URL('https://omg.example/api/x'));
  assert.equal(out.status, 201);
  assert.deepEqual(await out.json(), { ok: true });
  assert.equal(out.headers.get('cache-control'), 'no-store');
  const img = withSecurityHeaders(new Response('png', { status: 200 }), new URL('https://omg.example/img/logo.webp'));
  assert.equal(img.headers.get('cache-control'), 'public, max-age=604800');
});

test('booking references are OMG- and four unambiguous characters', () => {
  const refs = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const ref = newRef();
    assert.match(ref, /^OMG-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
    refs.add(ref);
  }
  assert.ok(refs.size > 1900);
});

test('www. addresses forward to the bare domain, keeping the path and query', async () => {
  const res = await worker.fetch(new Request('https://www.ohmyglam.online/admin/?tab=calendar'), {}, {});
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://ohmyglam.online/admin/?tab=calendar');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', 'security headers on the redirect too');
});
