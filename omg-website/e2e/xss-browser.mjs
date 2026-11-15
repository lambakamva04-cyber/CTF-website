#!/usr/bin/env node
// Browser check: hostile text stored through the API must reach the screen as
// text, never as markup.
//
// Through the API it stores a review carrying script and event-handler
// payloads and approves it, stores a second one and leaves it pending, and
// books a request under an unusual but valid name. Then, in Chromium, the
// public page must show the approved review and the admin page the pending one
// and the request, with nothing executed: no dialog, the window.__pwned canary
// unset, no injected elements, and no Content-Security-Policy violation (a
// violation would mean markup got in and only the CSP stopped it).
//
//   BASE_URL, ADMIN_PASSWORD as for security.mjs. Needs Playwright + Chromium.

import { createRequire } from 'node:module';
import { randomBytes, randomInt } from 'node:crypto';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not available. Install it, or run e2e/run.sh with SKIP_BROWSER=1.');
  process.exit(2);
}

const BASE = new URL(process.env.BASE_URL || 'http://127.0.0.1:8804');
const PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!PASSWORD) {
  console.error('ADMIN_PASSWORD is not set. Use e2e/run.sh, or export the password of the Worker under test.');
  process.exit(2);
}

const RUN = randomInt(1, 250);
const NONCE = randomBytes(4).toString('hex');
const TAG = NONCE.replace(/\d/g, (d) => 'ghijklmnop'[d]);
const ip = (n) => `10.15.${RUN}.${n}`;

const PAYLOAD = `<img src=x onerror="window.__pwned='img'"> <script>window.__pwned='script'</script> `
  + `<svg onload="window.__pwned='svg'"></svg> <a href="javascript:window.__pwned='href'">link</a> {{constructor.constructor('window.__pwned=1')()}}`;
const PUBLIC_MARK = `[pub${NONCE}]`;
const ADMIN_MARK = `[adm${NONCE}]`;
const ODD_NAME = `D'Angelo O'Neil-Smith Jr. ${TAG[0].toUpperCase()}${TAG.slice(1)}`;
const SHOWN = '<img src=x onerror='; // must appear on screen as text

// ---------------------------------------------------------------- reporting

const results = [];
const snip = (t, n = 300) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push(true);
    console.log(`PASS  [browser] ${name}${detail ? ` — ${snip(detail, 200)}` : ''}`);
  } catch (err) {
    results.push(false);
    console.log(`FAIL  [browser] ${name} — ${snip(err?.message ?? err, 400)}`);
  }
}
function ensure(cond, message) {
  if (!cond) throw new Error(message);
}

// ---------------------------------------------------------------- API helpers

async function api(method, path, { json, cookie, ipAddr } = {}) {
  const headers = { 'cf-connecting-ip': ipAddr || ip(randomInt(100, 250)) };
  if (method !== 'GET') headers.origin = BASE.origin;
  if (cookie) headers.cookie = cookie;
  if (json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(new URL(path, BASE), {
    method, headers, body: json === undefined ? undefined : JSON.stringify(json), signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, headers: res.headers, text, body };
}

function cookieFrom(res) {
  const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  const line = lines.find((l) => l.startsWith('__Host-omg_admin='));
  return line ? line.split(';')[0] : null;
}

// ---------------------------------------------------------------- browser helpers

async function openPage(browser, url, ipAddr) {
  const context = await browser.newContext({ extraHTTPHeaders: { 'CF-Connecting-IP': ipAddr } });
  const page = await context.newPage();
  const dialogs = [];
  const errors = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    d.dismiss().catch(() => {});
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push(`${e.violatedDirective} ${e.blockedURI || ''} ${e.sample || ''}`.trim());
    });
  });
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  await page.waitForTimeout(1500);
  return { context, page, dialogs, errors };
}

async function waitForText(page, text, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await page.evaluate((t) => document.body.innerText.includes(t), text)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/** What a page looks like after the payload has been rendered. */
function inspect(page) {
  return page.evaluate((shown) => ({
    pwned: window.__pwned ?? null,
    csp: window.__csp || [],
    injected: [...document.querySelectorAll(
      'img[src="x"], svg[onload], [onerror], [onload], [onclick], [onmouseover], a[href^="javascript:" i], script:not([src]):not([type="application/ld+json"]):not([type="application/json"])',
    )].map((el) => el.outerHTML.slice(0, 80)),
    shown: document.body.innerText.includes(shown),
  }), SHOWN);
}

function assertClean(state, dialogs) {
  ensure(state.pwned === null, `a payload ran: window.__pwned = ${JSON.stringify(state.pwned)}`);
  ensure(dialogs.length === 0, `dialogs opened: ${dialogs.join(' | ')}`);
  ensure(state.injected.length === 0, `markup was injected: ${state.injected.slice(0, 3).join(' | ')}`);
  ensure(state.csp.length === 0, `CSP violations (markup got in, or the page breaks its own CSP): ${state.csp.slice(0, 3).join(' | ')}`);
}

/** Clicks whatever tab or button reveals a section, if the admin page has one. */
async function reveal(page, pattern) {
  for (const role of ['tab', 'button', 'link']) {
    const loc = page.getByRole(role, { name: pattern });
    if (await loc.count()) {
      await loc.first().click().catch(() => {});
      await page.waitForTimeout(1000);
      return true;
    }
  }
  return false;
}

/** Logs in from inside the page, so the browser itself holds the session cookie. */
async function loginInPage(page) {
  const login = await page.evaluate(async (pw) => {
    const r = await fetch('/api/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }),
    });
    return r.status;
  }, PASSWORD);
  const session = await page.evaluate(async () => (await fetch('/api/admin/session')).status);
  return { login, session };
}

// ================================================================ setup

async function setup() {
  const state = {};
  const login = await api('POST', '/api/admin/login', { json: { password: PASSWORD }, ipAddr: ip(1) });
  state.cookie = cookieFrom(login);
  if (login.status !== 200 || !state.cookie) {
    console.error(`Admin login through the API failed (${login.status} ${snip(login.text, 120)}); cannot set up the browser checks.`);
    process.exit(1);
  }
  const admin = (method, path, json) => api(method, path, { json, cookie: state.cookie, ipAddr: ip(1) });

  const pub = await api('POST', '/api/reviews', {
    ipAddr: ip(2), json: { name: 'Xss Tester', rating: 4, comment: `${PAYLOAD} ${PUBLIC_MARK}`, company: '', elapsed: 30_000 },
  });
  state.publicStored = pub.status === 201;
  state.publicStatus = pub.status;
  if (state.publicStored) {
    const pending = await admin('GET', '/api/admin/reviews?status=pending');
    const mine = (pending.body?.reviews || []).find((r) => String(r.comment).includes(PUBLIC_MARK));
    ensure(mine, 'the public payload review is not in the pending list');
    const approved = await admin('POST', `/api/admin/reviews/${mine.id}/approve`, {});
    ensure(approved.status === 200, `approving it returned ${approved.status}`);
  }

  const pending = await api('POST', '/api/reviews', {
    ipAddr: ip(3), json: { name: 'Xss Pending', rating: 2, comment: `${PAYLOAD} ${ADMIN_MARK}`, company: '', elapsed: 30_000 },
  });
  state.pendingStored = pending.status === 201;
  state.pendingStatus = pending.status;

  const avail = await api('GET', `/api/availability?month=${new Date(Date.now() + 7_200_000).toISOString().slice(0, 7)}`);
  const today = avail.body?.today || new Date(Date.now() + 7_200_000).toISOString().slice(0, 10);
  const [y, m, d] = today.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + 60)).toISOString().slice(0, 10);
  const phone = `073 ${String(RUN).padStart(3, '0')} ${String(randomInt(1000, 9999))}`;

  const odd = await api('POST', '/api/bookings', {
    ipAddr: ip(4), json: { name: ODD_NAME, phone, service: 'full-glam', date, time: '10:00', company: '', elapsed: 30_000 },
  });
  state.oddStored = odd.status === 201;
  state.oddStatus = odd.status;

  const hostile = await api('POST', '/api/bookings', {
    ipAddr: ip(5),
    json: { name: '<img src=x onerror=alert(1)> Smith', phone: `${phone.slice(0, -1)}9`, service: 'full-glam', date, time: '12:00', company: '', elapsed: 30_000 },
  });
  state.hostileStatus = hostile.status;
  return state;
}

// ================================================================ checks

async function main() {
  console.log(`OMG browser XSS checks against ${BASE.origin} (run ${RUN}, nonce ${NONCE})`);
  const state = await setup();
  const browser = await chromium.launch();
  try {
    await check('a booking request named with an <img onerror> payload is refused', async () => {
      ensure(state.hostileStatus === 400, `got ${state.hostileStatus}; expected 400 from the name rules`);
      return '400';
    });

    await check('public page: an approved review with script payloads shows as text and runs nothing', async () => {
      if (!state.publicStored) return `refused at input (${state.publicStatus}), so it can never reach the page`;
      const { context, page, dialogs, errors } = await openPage(browser, `${BASE.origin}/`, ip(10));
      try {
        let found = false;
        // Allow for the reviews list being cached for up to a minute.
        for (let attempt = 0; attempt < 4 && !found; attempt += 1) {
          if (attempt) await page.reload({ waitUntil: 'load' });
          await page.evaluate(() => {
            const el = document.querySelector('#reviews');
            if (el) el.scrollIntoView();
            else window.scrollTo(0, document.body.scrollHeight);
          });
          found = await waitForText(page, PUBLIC_MARK, 20_000);
        }
        ensure(found, 'the approved review never appeared on the page (is the reviews section loading?)');
        const result = await inspect(page);
        assertClean(result, dialogs);
        ensure(result.shown, `the payload is not visible as text (looked for ${JSON.stringify(SHOWN)})`);
        if (errors.length) console.log(`INFO  [browser] page errors on /: ${snip(errors.join(' | '), 200)}`);
        return 'payload visible as literal text, nothing executed';
      } finally {
        await context.close();
      }
    });

    await check('admin page: a pending review with script payloads and an unusual name show as text', async () => {
      let base = BASE;
      let opened = await openPage(browser, `${base.origin}/admin/`, ip(11));
      let auth = await loginInPage(opened.page);
      if (auth.session !== 200 && base.hostname !== 'localhost') {
        // Chromium keeps Secure cookies from http only on hosts it trusts; localhost always qualifies.
        await opened.context.close();
        base = new URL(BASE);
        base.hostname = 'localhost';
        opened = await openPage(browser, `${base.origin}/admin/`, ip(12));
        auth = await loginInPage(opened.page);
      }
      const { context, page, dialogs, errors } = opened;
      try {
        ensure(auth.login === 200 && auth.session === 200, `in-browser login gave ${auth.login}, then session ${auth.session}`);
        await page.reload({ waitUntil: 'load' });
        await page.waitForTimeout(1500);
        const notes = [];

        if (state.pendingStored) {
          await reveal(page, /reviews/i);
          ensure(await waitForText(page, ADMIN_MARK, 15_000), 'the pending review is not shown on the admin page');
          notes.push('pending review shown as text');
        } else {
          notes.push(`pending review refused at input (${state.pendingStatus})`);
        }
        let result = await inspect(page);
        assertClean(result, dialogs);
        if (state.pendingStored) ensure(result.shown, 'the payload is not visible as text');

        if (state.oddStored) {
          await reveal(page, /requests/i);
          ensure(await waitForText(page, ODD_NAME, 15_000), `the request from ${JSON.stringify(ODD_NAME)} is not shown exactly`);
          result = await inspect(page);
          assertClean(result, dialogs);
          notes.push('apostrophes and dots in a name shown exactly');
        } else {
          notes.push(`request with an unusual name refused (${state.oddStatus})`);
        }
        if (errors.length) console.log(`INFO  [browser] page errors on /admin/: ${snip(errors.join(' | '), 200)}`);
        if (base !== BASE) notes.push('logged in via localhost');
        return notes.join('; ');
      } finally {
        await context.close();
      }
    });
  } finally {
    await browser.close();
  }

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('The browser check itself crashed:', err);
  process.exit(1);
});
