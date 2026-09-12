import 'server-only';
import { cache } from 'react';

import { db } from './supabase';
import type { DemoEventType, PublicProspect } from './demo';

type ProspectRow = {
  id: string;
  slug: string;
  practice_name: string;
  suburb: string | null;
  services: string[] | null;
  hours: string | null;
  demo_used_at: string | null;
};

const PROSPECT_COLUMNS = 'id, slug, practice_name, suburb, services, hours, demo_used_at';

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
    practice_name: row.practice_name,
    suburb: row.suburb,
    services: row.services ?? [],
    hours: row.hours,
    expired: row.demo_used_at !== null,
  };
}

export type RecordEventInput = {
  prospectId: string;
  eventType: DemoEventType;
  durationSeconds?: number | null;
  endedReason?: string | null;
  userAgent?: string | null;
};

export async function recordEvent(input: RecordEventInput): Promise<void> {
  const { error } = await db().from('demo_events').insert({
    prospect_id: input.prospectId,
    event_type: input.eventType,
    duration_seconds: input.durationSeconds ?? null,
    ended_reason: input.endedReason ?? null,
    user_agent: input.userAgent ?? null,
  });

  if (error) throw new Error(`event insert failed: ${error.message}`);
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
