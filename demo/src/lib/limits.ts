import 'server-only';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { headers } from 'next/headers';
import { cache } from 'react';

import { hashCallerHeaders } from './caller';

/**
 * Per-visitor request limits, enforced by Cloudflare's rate limiting bindings
 * (declared under `ratelimits` in wrangler.jsonc). Counters live at the edge,
 * so a flood is refused without touching Supabase.
 *
 * These stop floods; the database limits stop abuse. The public line's
 * per-caller and daily caps, the callback form's hourly and daily caps, and
 * each link's single use all stay where they are.
 */
export type LimiterName = 'DEMO_READ_LIMITER' | 'DEMO_EVENT_LIMITER' | 'LEAD_FORM_LIMITER';

type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

/**
 * True when this visitor may go ahead. Keyed on the hashed IP, the same one
 * the database limits count, so no address is handed to the counter either.
 *
 * Fails open: with no binding (the Next dev server) or no hash (no Cloudflare
 * header), or if the limiter itself errors, the request proceeds to the
 * database limits behind it. A broken counter must not take the demo down.
 */
export async function withinLimit(name: LimiterName, ipHash: string | null): Promise<boolean> {
  if (!ipHash) return true;

  let limiter: RateLimiter | undefined;
  try {
    limiter = (getCloudflareContext().env as unknown as Record<string, RateLimiter | undefined>)[name];
  } catch {
    return true;
  }
  if (!limiter) return true;

  try {
    const { success } = await limiter.limit({ key: ipHash });
    return success;
  } catch (error) {
    console.error('rate limiter failed', name, error);
    return true;
  }
}

/**
 * The demo page's check, made once per page load: the page and its metadata
 * both run, and must not count as two requests.
 */
export const demoPageAllowed = cache(async (): Promise<boolean> =>
  withinLimit('DEMO_READ_LIMITER', await hashCallerHeaders(await headers())),
);
