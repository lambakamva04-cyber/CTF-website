import { NextResponse } from 'next/server';

import { hashCallerIp } from '@/lib/caller';
import { leadLimitReached, saveLead } from '@/lib/leads';

export const dynamic = 'force-dynamic';

/**
 * The marketing site is the only page that posts here. It lives on another
 * origin, so every answer carries the CORS header for it.
 */
const ALLOWED_ORIGINS = new Set([
  'https://www.cutthroughfaster.com',
  'https://cutthroughfaster.com',
]);

const LIMITS = {
  name: 120,
  businessType: 60,
  phone: 30,
  message: 2000,
  userAgent: 400,
};

function corsHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', Vary: 'Origin' };
  const origin = request.headers.get('origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function reply(request: Request, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: corsHeaders(request) });
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** A South African or international number: 9 to 15 digits, usual punctuation. */
function isPlausiblePhone(value: string): boolean {
  if (!/^\+?[\d\s().-]+$/.test(value)) return false;
  const digits = value.replace(/\D/g, '').length;
  return digits >= 9 && digits <= 15;
}

/** The browser's preflight, sent because the form posts JSON. */
export async function OPTIONS(request: Request) {
  const headers = corsHeaders(request);
  if (!headers['Access-Control-Allow-Origin']) {
    return new NextResponse(null, { status: 403, headers });
  }
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...headers,
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

/**
 * POST /api/lead
 *
 * A callback request from the marketing site's contact form, saved to the
 * `leads` table. Unauthenticated by necessity, so:
 *
 * - Only JSON is accepted. That forces a browser on any other site through a
 *   CORS preflight this route refuses, so a stranger's page cannot post a lead
 *   in a visitor's name.
 * - A filled-in honeypot field is answered as a success and dropped, so a bot
 *   learns nothing from the response.
 * - One sender gets a few requests an hour, and everyone together a ceiling a
 *   day, counted on the hashed IP. The address itself is never stored.
 */
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return reply(request, { error: 'forbidden' }, 403);
  }

  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return reply(request, { error: 'invalid_body' }, 415);
  }

  let body: Record<string, unknown>;
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return reply(request, { error: 'invalid_body' }, 400);
  }

  if (text(body.company_website, 200)) {
    return reply(request, { ok: true });
  }

  const name = text(body.name, LIMITS.name);
  const phone = text(body.phone, LIMITS.phone);
  const invalid: string[] = [];
  if (!name) invalid.push('name');
  if (!phone || !isPlausiblePhone(phone)) invalid.push('phone');
  if (invalid.length > 0 || !name || !phone) {
    return reply(request, { error: 'invalid_fields', fields: invalid }, 400);
  }

  try {
    const ipHash = await hashCallerIp(request);
    if (await leadLimitReached(ipHash)) {
      return reply(request, { error: 'too_many_requests' }, 429);
    }

    await saveLead({
      name,
      phone,
      businessType: text(body.business_type, LIMITS.businessType),
      message: text(body.message, LIMITS.message),
      ipHash,
      userAgent: text(request.headers.get('user-agent'), LIMITS.userAgent),
    });
  } catch (error) {
    console.error('lead not saved', error);
    return reply(request, { error: 'not_saved' }, 500);
  }

  return reply(request, { ok: true });
}
