import { NextResponse } from 'next/server';

import { db } from '@/lib/supabase';

// Recipients click this from an email client, so it is a GET and is never
// authenticated. Its answer depends on a secret token and writes to the
// suppression list, so it must never be cached by a shared proxy.
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * The link only works with a token that is an HMAC of the email under
 * UNSUBSCRIBE_SECRET. Without it, one recipient could unsubscribe another by
 * editing the address in the URL, and the list could be probed by guessing.
 */
function unsubscribeSecret(): string {
  const secret = process.env.UNSUBSCRIBE_SECRET?.trim();
  if (!secret) throw new Error('Missing required environment variable UNSUBSCRIBE_SECRET.');
  return secret;
}

/** The address folded to the one form the token signs and the tables store. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Lowercase hex HMAC-SHA256 of the normalised email, the same digest style as
 * caller.ts. The email is normalised first, so a difference in case or
 * surrounding space never changes the token.
 */
async function signEmail(email: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(unsubscribeSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(normalizeEmail(email)));
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time compare. Both sides are fixed-length hex, so the length check
 * leaks nothing, and the loop runs the same whether a token is wrong in the
 * first character or the last — a plain `===` can return early and be timed.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The signed unsubscribe URL to embed in an email to `email`. Built from the
 * request `origin` when one is given (so a preview deploy links to itself),
 * otherwise DEMO_BASE_URL, otherwise the production demo host. Async because
 * signing is async.
 */
export async function unsubscribeUrl(email: string, origin?: string): Promise<string> {
  const base =
    origin?.replace(/\/$/, '') ||
    process.env.DEMO_BASE_URL?.replace(/\/$/, '') ||
    'https://demo.cutthroughfaster.com';
  const normalized = normalizeEmail(email);
  const token = await signEmail(normalized);
  return `${base}/api/unsubscribe?e=${encodeURIComponent(normalized)}&t=${token}`;
}

/**
 * Adds the address to the suppression list and stamps any matching outreach row
 * as opted out. Idempotent: a repeat click inserts nothing (the unique index on
 * lower(email) catches it) and the `is null` guard keeps the first opt-out time
 * in place. Matching outreach by `contact_email` relies on it being stored
 * lowercased — which the importer (scripts/import-outreach.mjs) does.
 */
async function suppress(email: string): Promise<void> {
  const { error: insertError } = await db()
    .from('email_suppression')
    .insert({ email, reason: 'unsubscribe', source: 'unsubscribe_link' });
  // 23505 is the unique-violation: already on the list, which is success here.
  if (insertError && insertError.code !== '23505') {
    throw new Error(`suppression insert failed: ${insertError.message}`);
  }

  const now = new Date().toISOString();
  const { error: updateError } = await db()
    .from('outreach')
    .update({ opted_out_at: now, updated_at: now })
    .eq('contact_email', email)
    .is('opted_out_at', null);
  if (updateError) throw new Error(`opt-out update failed: ${updateError.message}`);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A small branded page. No external resources, so it needs no CSP exceptions. */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title} · Cut Through Faster</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #0b1020; color: #e8ecf5; }
  .card { width: 100%; max-width: 32rem; box-sizing: border-box; text-align: center;
    background: #141b30; border: 1px solid #263152; border-radius: 16px; padding: 40px 32px; }
  h1 { margin: 0 0 12px; font-size: 1.4rem; }
  p { margin: 0 0 8px; color: #aeb8d4; }
  .email { color: #e8ecf5; font-weight: 600; word-break: break-all; }
  a { color: #8ab4ff; }
  .brand { margin-top: 28px; font-size: 0.85rem; color: #6b77a0; }
</style>
</head>
<body>
  <main class="card">
${body}
    <p class="brand">Cut Through Faster · <a href="https://cutthroughfaster.com">cutthroughfaster.com</a></p>
  </main>
</body>
</html>`;
}

function htmlResponse(html: string, status: number): NextResponse {
  return new NextResponse(html, {
    status,
    headers: { ...NO_STORE, 'content-type': 'text/html; charset=utf-8' },
  });
}

const INVALID_BODY = `    <h1>This link is not valid</h1>
    <p>The unsubscribe link may be incomplete or out of date.</p>
    <p>If you would rather not hear from us, reply to any of our emails and we'll take you off the list.</p>`;

const ERROR_BODY = `    <h1>Something went wrong</h1>
    <p>We couldn't process that just now. Please try again in a few minutes, or reply to any of our emails and we'll take you off the list.</p>`;

function successBody(email: string): string {
  return `    <h1>You've been unsubscribed</h1>
    <p><span class="email">${escapeHtml(email)}</span> has been removed.</p>
    <p>You won't receive any more outreach from us. Anything already scheduled can take a little while to stop.</p>`;
}

/**
 * GET /api/unsubscribe?e=<email>&t=<token>
 *
 * Opts the recipient out: adds their email to the suppression list and marks
 * their outreach row opted out, then shows a branded confirmation. A missing or
 * wrong token is answered exactly like malformed input — a neutral 400 — so the
 * endpoint says nothing about which addresses exist or what a token looks like.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const email = url.searchParams.get('e');
  const token = url.searchParams.get('t');

  if (!email || !token) {
    return htmlResponse(page('Link not valid', INVALID_BODY), 400);
  }

  let expected: string;
  try {
    expected = await signEmail(email);
  } catch (error) {
    // The secret is unset — a server misconfiguration, not the recipient's
    // fault. Nothing is leaked; it is logged for us and shown as a neutral
    // error so a working link is not reported as invalid by mistake.
    console.error('unsubscribe not configured', error);
    return htmlResponse(page('Something went wrong', ERROR_BODY), 500);
  }

  if (!timingSafeEqual(token, expected)) {
    return htmlResponse(page('Link not valid', INVALID_BODY), 400);
  }

  const normalized = normalizeEmail(email);
  try {
    await suppress(normalized);
  } catch (error) {
    console.error('unsubscribe failed', error);
    return htmlResponse(page('Something went wrong', ERROR_BODY), 500);
  }

  return htmlResponse(page('Unsubscribed', successBody(normalized)), 200);
}
