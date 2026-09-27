import 'server-only';

import { demoIpSalt } from './env';

/**
 * A salted SHA-256 of the caller's IP address, or null.
 *
 * The address itself is never stored. The hash lets the public line count
 * calls per person and the callback form count requests per sender, and the
 * nightly `prune_demo_event_identifiers` job strips it from demo events after
 * 30 days.
 *
 * Only `cf-connecting-ip` is read. Cloudflare sets it on every request and a
 * client cannot override it; `x-forwarded-for` can be written by anyone, and
 * trusting it would let one person reset their own limit with a header. With
 * no Cloudflare header (the Next dev server) or no salt, the result is null.
 */
export async function hashCallerIp(request: Request): Promise<string | null> {
  const ip = request.headers.get('cf-connecting-ip')?.trim();
  const salt = demoIpSalt();
  if (!ip || !salt) return null;

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${ip}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
