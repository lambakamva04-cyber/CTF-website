import 'server-only';
import { cache } from 'react';

import { db } from './supabase';
import {
  isIndustry,
  PUBLIC_LINE_FALLBACK_SECONDS,
  type DemoEventType,
  type GateResponse,
  type Industry,
  type PublicProspect,
} from './demo';

export type ProspectRow = {
  id: string;
  slug: string;
  /** 'dental' or 'legal' (migration 0013). Anything else is treated as dental. */
  industry: string | null;
  practice_name: string;
  suburb: string | null;
  services: string[] | null;
  hours: string | null;
  demo_used_at: string | null;
  /** The always-on line on the marketing site. Never spent; rate limited instead. */
  is_public: boolean;
  /** CTF's own test rows. Never spent and never shown as expired. */
  is_test: boolean;
};

const PROSPECT_COLUMNS =
  'id, slug, industry, practice_name, suburb, services, hours, demo_used_at, is_public, is_test';

/** The row's industry. Every row before migration 0013 was a dental practice. */
export function industryOf(row: ProspectRow): Industry {
  return isIndustry(row.industry) ? row.industry : 'dental';
}

/** Public and test links are never spent: one call does not use them up. */
export function isReusable(row: ProspectRow): boolean {
  return row.is_public || row.is_test;
}

/**
 * Null for an unknown slug. Callers turn that into a bare 404.
 *
 * Memoised per request, because the page and its `generateMetadata` both need
 * the row and neither should cost a second round trip to Supabase.
 */
export const getProspectBySlug = cache(async (slug: string): Promise<ProspectRow | null> => {
  const { data, error } = await db()
    .from('prospects')
    .select(PROSPECT_COLUMNS)
    .eq('slug', slug)
    .maybeSingle<ProspectRow>();

  if (error) throw new Error(`prospect lookup failed: ${error.message}`);
  return data ?? null;
});

/**
 * Strips the row down to what the page is allowed to show. `id` and
 * `demo_used_at` stay on the server; the browser only learns `expired`.
 */
export function toPublicProspect(row: ProspectRow): PublicProspect {
  return {
    slug: row.slug,
    industry: industryOf(row),
    practice_name: row.practice_name,
    suburb: row.suburb,
    services: row.services ?? [],
    hours: row.hours,
    expired: !isReusable(row) && row.demo_used_at !== null,
    public_line: row.is_public,
  };
}

export type RecordEventInput = {
  prospectId: string;
  eventType: DemoEventType;
  durationSeconds?: number | null;
  endedReason?: string | null;
  userAgent?: string | null;
  /** Public line `call_started` only: what the per-person limit counts. */
  ipHash?: string | null;
};

export async function recordEvent(input: RecordEventInput): Promise<void> {
  const { error } = await db().from('demo_events').insert({
    prospect_id: input.prospectId,
    event_type: input.eventType,
    duration_seconds: input.durationSeconds ?? null,
    ended_reason: input.endedReason ?? null,
    user_agent: input.userAgent ?? null,
    ip_hash: input.ipHash ?? null,
  });

  if (error) throw new Error(`event insert failed: ${error.message}`);
}

/**
 * The public line's call length, from `demo_limits` so it can be changed in
 * Supabase without a deploy. Only the page's copy uses this; the number a
 * call actually runs to comes back from the gate. Memoised per request, like
 * the prospect, for the page and its metadata.
 */
export const getPublicLineSeconds = cache(async (): Promise<number> => {
  const { data, error } = await db()
    .from('demo_limits')
    .select('max_seconds')
    .eq('id', 1)
    .maybeSingle<{ max_seconds: number }>();

  if (error || !data) return PUBLIC_LINE_FALLBACK_SECONDS;
  return data.max_seconds;
});

/**
 * Asks `public_demo_gate()` whether the public line may take another call. The
 * limits live in the database function and the `demo_limits` row: calls per
 * person per hour, and calls per day across everyone.
 *
 * A failed check refuses nothing here — it throws, and the route answers with
 * an error, so an unreadable limit never turns into unlimited calls.
 */
export async function checkPublicGate(ipHash: string | null): Promise<GateResponse> {
  const { data, error } = await db().rpc('public_demo_gate', { p_ip_hash: ipHash });
  if (error) throw new Error(`public demo gate failed: ${error.message}`);

  const result = (data ?? {}) as { allowed?: unknown; reason?: unknown; max_seconds?: unknown };
  if (result.allowed === true && typeof result.max_seconds === 'number') {
    return { allowed: true, max_seconds: result.max_seconds };
  }
  if (result.reason === 'ip_cooldown' || result.reason === 'daily_cap') {
    return { allowed: false, reason: result.reason };
  }
  throw new Error('public demo gate returned an unexpected answer');
}

/**
 * Spends the link. The `is null` guard makes this the atomic claim: the first
 * caller to start a call gets `true`, every later one gets `false`, with no
 * read-then-write race between two tabs.
 */
export async function claimDemo(prospectId: string): Promise<boolean> {
  const { data, error } = await db()
    .from('prospects')
    .update({ demo_used_at: new Date().toISOString() })
    .eq('id', prospectId)
    .is('demo_used_at', null)
    .select('id');

  if (error) throw new Error(`claiming demo failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}
