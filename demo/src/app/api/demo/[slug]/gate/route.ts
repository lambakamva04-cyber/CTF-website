import { NextResponse } from 'next/server';

import { hashCallerIp } from '@/lib/caller';
import { DEMO_MAX_SECONDS, isValidSlug, type GateResponse } from '@/lib/demo';
import { withinLimit } from '@/lib/limits';
import { checkPublicGate, getProspectBySlug } from '@/lib/prospects';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * POST /api/demo/[slug]/gate
 *
 * Asked by the page just before it starts a call on the public line, so a
 * crowd from the marketing site cannot drain the Vapi balance the prospects'
 * links depend on. The answer carries the call length to use, from
 * `demo_limits`.
 *
 * This is budget control for ordinary visitors, not a lock: the Vapi public
 * key is in the page by design, so a browser that skips this check can still
 * start a call — the same exposure every demo link already has. What it cannot
 * do is make this route say yes.
 *
 * Personal links have no gate; they are spent by their first call instead.
 * Asked about one anyway, the route answers with the standard cap.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const callerHash = await hashCallerIp(request);
  if (!(await withinLimit('DEMO_READ_LIMITER', callerHash))) {
    return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: NO_STORE });
  }

  if (!isValidSlug(slug)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  const prospect = await getProspectBySlug(slug);
  if (!prospect) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  if (!prospect.is_public) {
    const body: GateResponse = { allowed: true, max_seconds: DEMO_MAX_SECONDS };
    return NextResponse.json(body, { headers: NO_STORE });
  }

  const verdict = await checkPublicGate(callerHash);
  return NextResponse.json(verdict, { headers: NO_STORE });
}
