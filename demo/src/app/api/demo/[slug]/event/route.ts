import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/body';
import { hashCallerIp } from '@/lib/caller';
import { DEMO_MAX_SECONDS, isDemoEventType, isValidSlug } from '@/lib/demo';
import { withinLimit } from '@/lib/limits';
import {
  checkPublicGate,
  claimDemo,
  getProspectBySlug,
  isReusable,
  recordEvent,
} from '@/lib/prospects';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

// Generous headroom over the cap, so a call that overruns by a few seconds is
// still recorded honestly instead of being clipped to the cap.
const MAX_DURATION_SECONDS = DEMO_MAX_SECONDS * 2;
const MAX_ENDED_REASON_CHARS = 120;
const MAX_USER_AGENT_CHARS = 400;
/** An event is three short fields. */
const MAX_BODY_BYTES = 4 * 1024;

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
 * stamping `demo_used_at`, which is what makes a demo link single-use — except
 * on the public line and CTF's test links, which are never spent. A public
 * line `call_started` carries the caller's hashed IP instead, because those
 * rows are what `public_demo_gate()` counts.
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

  // A real visit sends a handful of events. Anything like a flood — someone
  // scripting fake views, or trying slugs to spend other people's links — is
  // refused at the edge before it reaches the database.
  const callerHash = await hashCallerIp(request);
  if (!(await withinLimit('DEMO_EVENT_LIMITER', callerHash))) {
    return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: NO_STORE });
  }

  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if (!read.ok) {
    return NextResponse.json({ error: 'invalid_body' }, { status: read.status, headers: NO_STORE });
  }

  const payload = (read.value && typeof read.value === 'object' ? read.value : {}) as Record<
    string,
    unknown
  >;
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
  if (eventType === 'call_started' && !isReusable(prospect)) {
    firstUse = await claimDemo(prospect.id);
  }

  // The public line's limits count these rows, so one has to pass the same
  // gate a real call did. Otherwise fifteen forged requests, with no call
  // behind them, would close the line to everyone for the day.
  let ipHash: string | null = null;
  if (eventType === 'call_started' && prospect.is_public) {
    ipHash = callerHash;
    const verdict = await checkPublicGate(ipHash);
    if (!verdict.allowed) {
      return NextResponse.json(
        { error: 'limit_reached', reason: verdict.reason },
        { status: 429, headers: NO_STORE },
      );
    }
  }

  await recordEvent({
    prospectId: prospect.id,
    eventType,
    durationSeconds: eventType === 'call_ended' ? clampDuration(payload.duration_seconds) : null,
    endedReason:
      eventType === 'call_ended' ? trim(payload.ended_reason, MAX_ENDED_REASON_CHARS) : null,
    userAgent: trim(request.headers.get('user-agent'), MAX_USER_AGENT_CHARS),
    ipHash,
  });

  return NextResponse.json({ ok: true, first_use: firstUse }, { headers: NO_STORE });
}
