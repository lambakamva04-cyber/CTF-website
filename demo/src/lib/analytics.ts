import 'server-only';

import { db } from './supabase';

/**
 * The data layer behind the internal admin analytics dashboard.
 *
 * Every function reads with the service-role client and returns a plain DTO —
 * no Supabase types leak past this module, so the dashboard (a server
 * component) depends only on the shapes below.
 *
 * "The campaign" is the set of real cold-outreach prospects. `is_public` is the
 * always-on marketing line and `is_test` is CTF's own rows; neither belongs in
 * the founder's numbers, so every query here keeps to is_public = false and
 * is_test = false — applied directly on `prospects`, or as a filter on the
 * joined prospect (`prospects!inner`) when reading a child table.
 */

/** The funnel across all campaign prospects, as counts and call-length stats. */
export type DemoFunnel = {
  /** Campaign prospects seeded — the top of the funnel. */
  prospects: number;
  /** Prospects with at least one page_view. */
  opened: number;
  /** Prospects with at least one call_started. */
  callStarted: number;
  /** Prospects with at least one call_ended. */
  callEnded: number;
  /** call_started events in total — a prospect can retry, so this can exceed `callStarted`. */
  totalCalls: number;
  /** Mean call length over call_ended events, to one decimal, or null when there are none. */
  avgCallSeconds: number | null;
  /** Median call length over call_ended events, or null when there are none. */
  medianCallSeconds: number | null;
  /** mic_denied events in total. */
  micDenied: number;
  /** link_expired events in total. */
  linkExpired: number;
};

/** One campaign prospect's engagement, for the per-prospect table. */
export type ProspectEngagement = {
  prospectId: string;
  practiceName: string;
  suburb: string | null;
  /** Has at least one page_view. */
  opened: boolean;
  /** call_started events for this prospect. */
  calls: number;
  /** The most recent demo_events timestamp, or null if nothing has happened. */
  lastEventAt: string | null;
  /** When the single-use link was spent, or null. */
  demoUsedAt: string | null;
};

/** The outreach cadence rolled up to a single set of totals. */
export type OutreachStats = {
  emailsSent: number;
  /** Sum of followups_sent across every cadence row. */
  followupsSent: number;
  /** Rows with any reply (responded_at set). */
  responses: number;
  /** Rows marked opted out. */
  optedOut: number;
  /** Rows the founder marked interested. */
  interested: number;
  connectsSent: number;
  dmsSent: number;
};

/** An interested contact joined to their prospect, for the follow-up list. */
export type InterestedLead = {
  contactName: string | null;
  practiceName: string;
  suburb: string | null;
  contactEmail: string | null;
  linkedinUrl: string | null;
  /** The prospect's slug and the shareable demo link built from it. */
  slug: string;
  demoUrl: string;
  interestedAt: string | null;
  notes: string | null;
};

/** The prospect's shareable demo link, from DEMO_BASE_URL or the demo host. */
function demoUrl(slug: string): string {
  const base = process.env.DEMO_BASE_URL?.replace(/\/$/, '') || 'https://demo.cutthroughfaster.com';
  return `${base}/demo/${slug}`;
}

/** Mean to one decimal place, or null for an empty set. */
function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  return Math.round((sum / values.length) * 10) / 10;
}

/** Median (the average of the two middle values on an even count), or null. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Every row of a child table whose prospect is a campaign prospect, read in
 * pages so the whole set comes back however large it grows. The `select` must
 * embed `prospects!inner(...)` for the campaign filter to be an inner join.
 * Ordered by id so the pages do not overlap or skip.
 */
async function fetchCampaignRows<T>(table: 'demo_events' | 'outreach', select: string): Promise<T[]> {
  const pageSize = 1000;
  const rows: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db()
      .from(table)
      .select(select)
      .eq('prospects.is_public', false)
      .eq('prospects.is_test', false)
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1)
      .returns<T[]>();

    if (error) throw new Error(`${table} read failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}

export async function getDemoFunnel(): Promise<DemoFunnel> {
  const { count, error } = await db()
    .from('prospects')
    .select('id', { count: 'exact', head: true })
    .eq('is_public', false)
    .eq('is_test', false);
  if (error) throw new Error(`prospect count failed: ${error.message}`);

  const events = await fetchCampaignRows<{
    prospect_id: string;
    event_type: string;
    duration_seconds: number | null;
  }>('demo_events', 'prospect_id, event_type, duration_seconds, prospects!inner(is_public, is_test)');

  /** Distinct prospects with at least one event of this type. */
  const prospectsWith = (type: string): number => {
    const ids = new Set<string>();
    for (const event of events) if (event.event_type === type) ids.add(event.prospect_id);
    return ids.size;
  };
  /** Events of this type. */
  const countOf = (type: string): number =>
    events.reduce((total, event) => (event.event_type === type ? total + 1 : total), 0);

  const durations = events
    .filter((event) => event.event_type === 'call_ended' && typeof event.duration_seconds === 'number')
    .map((event) => event.duration_seconds as number);

  return {
    prospects: count ?? 0,
    opened: prospectsWith('page_view'),
    callStarted: prospectsWith('call_started'),
    callEnded: prospectsWith('call_ended'),
    totalCalls: countOf('call_started'),
    avgCallSeconds: mean(durations),
    medianCallSeconds: median(durations),
    micDenied: countOf('mic_denied'),
    linkExpired: countOf('link_expired'),
  };
}

export async function getProspectEngagement(): Promise<ProspectEngagement[]> {
  const { data: prospects, error } = await db()
    .from('prospects')
    .select('id, practice_name, suburb, demo_used_at')
    .eq('is_public', false)
    .eq('is_test', false)
    .returns<
      { id: string; practice_name: string; suburb: string | null; demo_used_at: string | null }[]
    >();
  if (error) throw new Error(`prospect read failed: ${error.message}`);

  const events = await fetchCampaignRows<{
    prospect_id: string;
    event_type: string;
    created_at: string;
  }>('demo_events', 'prospect_id, event_type, created_at, prospects!inner(is_public, is_test)');

  // Fold the events down to one summary per prospect in a single pass.
  const summaries = new Map<string, { opened: boolean; calls: number; lastEventAt: string | null }>();
  for (const event of events) {
    const summary = summaries.get(event.prospect_id) ?? { opened: false, calls: 0, lastEventAt: null };
    if (event.event_type === 'page_view') summary.opened = true;
    if (event.event_type === 'call_started') summary.calls += 1;
    if (!summary.lastEventAt || event.created_at > summary.lastEventAt) summary.lastEventAt = event.created_at;
    summaries.set(event.prospect_id, summary);
  }

  const rows: ProspectEngagement[] = (prospects ?? []).map((prospect) => {
    const summary = summaries.get(prospect.id);
    return {
      prospectId: prospect.id,
      practiceName: prospect.practice_name,
      suburb: prospect.suburb,
      opened: summary?.opened ?? false,
      calls: summary?.calls ?? 0,
      lastEventAt: summary?.lastEventAt ?? null,
      demoUsedAt: prospect.demo_used_at,
    };
  });

  // Most-engaged first: more calls rank higher, a call outranks a mere open,
  // and ties break on who did something most recently (ISO timestamps sort
  // lexicographically; the empty string puts "never" last).
  rows.sort((a, b) => {
    if (b.calls !== a.calls) return b.calls - a.calls;
    if (a.opened !== b.opened) return a.opened ? -1 : 1;
    return (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? '');
  });

  return rows;
}

export async function getOutreachStats(): Promise<OutreachStats> {
  const rows = await fetchCampaignRows<{
    connect_sent_at: string | null;
    dm_sent_at: string | null;
    email_sent_at: string | null;
    followups_sent: number;
    responded_at: string | null;
    opted_out_at: string | null;
    interested: boolean;
  }>(
    'outreach',
    'connect_sent_at, dm_sent_at, email_sent_at, followups_sent, responded_at, opted_out_at, interested, prospects!inner(is_public, is_test)',
  );

  const stats: OutreachStats = {
    emailsSent: 0,
    followupsSent: 0,
    responses: 0,
    optedOut: 0,
    interested: 0,
    connectsSent: 0,
    dmsSent: 0,
  };
  for (const row of rows) {
    if (row.email_sent_at) stats.emailsSent += 1;
    stats.followupsSent += row.followups_sent ?? 0;
    if (row.responded_at) stats.responses += 1;
    if (row.opted_out_at) stats.optedOut += 1;
    if (row.interested) stats.interested += 1;
    if (row.connect_sent_at) stats.connectsSent += 1;
    if (row.dm_sent_at) stats.dmsSent += 1;
  }
  return stats;
}

export async function getInterestedLeads(): Promise<InterestedLead[]> {
  const { data, error } = await db()
    .from('outreach')
    .select(
      'contact_name, contact_email, linkedin_url, interested_at, notes, prospects!inner(practice_name, suburb, slug, is_public, is_test)',
    )
    .eq('interested', true)
    .eq('prospects.is_public', false)
    .eq('prospects.is_test', false)
    .order('interested_at', { ascending: false, nullsFirst: false })
    .returns<
      {
        contact_name: string | null;
        contact_email: string | null;
        linkedin_url: string | null;
        interested_at: string | null;
        notes: string | null;
        prospects: { practice_name: string; suburb: string | null; slug: string };
      }[]
    >();
  if (error) throw new Error(`interested leads read failed: ${error.message}`);

  return (data ?? []).map((row) => ({
    contactName: row.contact_name,
    practiceName: row.prospects.practice_name,
    suburb: row.prospects.suburb,
    contactEmail: row.contact_email,
    linkedinUrl: row.linkedin_url,
    slug: row.prospects.slug,
    demoUrl: demoUrl(row.prospects.slug),
    interestedAt: row.interested_at,
    notes: row.notes,
  }));
}
