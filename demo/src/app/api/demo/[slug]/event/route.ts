import { NextResponse } from 'next/server';

import { DEMO_MAX_SECONDS, isDemoEventType, isValidSlug } from '@/lib/demo';
import { claimDemo, getProspectBySlug, recordEvent } from '@/lib/prospects';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

// Generous headroom over the cap, so a call that overruns by a few seconds is
// still recorded honestly instead of being clipped to the cap.
const MAX_DURATION_SECONDS = DEMO_MAX_SECONDS * 2;
const MAX_ENDED_REASON_CHARS = 120;
const MAX_USER_AGENT_CHARS = 400;

function clampDuration(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(Math.max(Math.round(value), 0), MAX_DURATION_SECONDS);
}

function trim(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * POST /api/demo/[slug]/event
 *
 * Writes one `demo_events` row. On `call_started` it also spends the link by
 * stamping `demo_used_at`, which is what makes a demo link single-use.
 *
 * The endpoint is unauthenticated by necessity — the prospect has no login —
 * so everything it trusts is either validated here or taken from the request
 * itself. The user agent is read from the header, never from the body.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  if (!isValidSlug(slug)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const eventType = payload.event_type;

  if (!isDemoEventType(eventType)) {
    return NextResponse.json({ error: 'invalid_event_type' }, { status: 400, headers: NO_STORE });
  }

  const prospect = await getProspectBySlug(slug);
  if (!prospect) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  // `first_use` is false when the link was already spent — the tab that lost
  // the race, or a replayed request. The event is still recorded either way;
  // the funnel should show what actually happened.
  let firstUse = false;
  if (eventType === 'call_started') {
    firstUse = await claimDemo(prospect.id);
  }

  await recordEvent({
    prospectId: prospect.id,
    eventType,
    durationSeconds: eventType === 'call_ended' ? clampDuration(payload.duration_seconds) : null,
    endedReason:
      eventType === 'call_ended' ? trim(payload.ended_reason, MAX_ENDED_REASON_CHARS) : null,
    userAgent: trim(request.headers.get('user-agent'), MAX_USER_AGENT_CHARS),
  });

  return NextResponse.json({ ok: true, first_use: firstUse }, { headers: NO_STORE });
}
