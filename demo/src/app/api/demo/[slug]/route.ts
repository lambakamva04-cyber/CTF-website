import { NextResponse } from 'next/server';

import { hashCallerIp } from '@/lib/caller';
import { isValidSlug } from '@/lib/demo';
import { withinLimit } from '@/lib/limits';
import { getProspectBySlug, toPublicProspect } from '@/lib/prospects';

// Never cached: `expired` flips the moment a call starts.
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/demo/[slug]
 *
 * The prospect's display fields plus `expired`. An unknown slug and a
 * malformed slug return the identical 404 body, so the endpoint cannot be used
 * to enumerate which links exist.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  // Slows anyone walking through practice names to find links.
  if (!(await withinLimit('DEMO_READ_LIMITER', await hashCallerIp(request)))) {
    return NextResponse.json({ error: 'too_many_requests' }, { status: 429, headers: NO_STORE });
  }

  if (!isValidSlug(slug)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  const prospect = await getProspectBySlug(slug);
  if (!prospect) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  return NextResponse.json(toPublicProspect(prospect), { headers: NO_STORE });
}
