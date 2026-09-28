import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/body';
import { hashCallerIp } from '@/lib/caller';
import { isRepeatLead, leadLimitReached, saveLead, type LeadInput } from '@/lib/leads';
import { withinLimit } from '@/lib/limits';
import { emailNewLead } from '@/lib/notify';

export const dynamic = 'force-dynamic';

/**
 * The marketing site is the only page that posts here. It lives on another
 * origin, so every answer carries the CORS header for it.
 */
const ALLOWED_ORIGINS = new Set([
  'https://www.cutthroughfaster.com',
  'https://cutthroughfaster.com',
]);

/** The form sends five short fields; 16 KB is room for a long message and more. */
const MAX_BODY_BYTES = 16 * 1024;

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
 * `leads` table and emailed to LEAD_NOTIFY_TO. Unauthenticated by necessity, so:
 *
 * - Only JSON is accepted. That forces a browser on any other site through a
 *   CORS preflight this route refuses, so a stranger's page cannot post a lead
 *   in a visitor's name.
 * - A filled-in honeypot field is answered as a success and dropped, so a bot
 *   learns nothing from the response.
 * - One sender gets a few requests an hour, and everyone together a ceiling a
 *   day, counted on the hashed IP. The address itself is never stored. A
 *   flood is refused earlier still, at Cloudflare's edge counter.
 * - The body is capped at 16 KB, and a repeat of the same phone number within
 *   ten minutes is answered as sent without being saved or emailed again.
 */
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return reply(request, { error: 'forbidden' }, 403);
  }

  // Before anything is read or looked up: a flood from one sender is refused
  // at the edge counter without costing a database round trip.
  const ipHash = await hashCallerIp(request);
  if (!(await withinLimit('LEAD_FORM_LIMITER', ipHash))) {
    return reply(request, { error: 'too_many_requests' }, 429);
  }

  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if (!read.ok) {
    return reply(request, { error: 'invalid_body' }, read.status);
  }
  const body = (read.value && typeof read.value === 'object' ? read.value : {}) as Record<
    string,
    unknown
  >;

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

  let lead: LeadInput;
  try {
    if (await leadLimitReached(ipHash)) {
      return reply(request, { error: 'too_many_requests' }, 429);
    }

    // A double click, or a retry after a slow answer, is the same request.
    // Answered as a success, because it was one: the first copy is saved and
    // the team has been emailed about it.
    if (await isRepeatLead(phone)) {
      return reply(request, { ok: true });
    }

    lead = {
      name,
      phone,
      businessType: text(body.business_type, LIMITS.businessType),
      message: text(body.message, LIMITS.message),
      ipHash,
      userAgent: text(request.headers.get('user-agent'), LIMITS.userAgent),
    };
    await saveLead(lead);
  } catch (error) {
    console.error('lead not saved', error);
    return reply(request, { error: 'not_saved' }, 500);
  }

  // The request is saved by now, so a failed email must not turn into an
  // error on the form: the visitor would try again and be saved twice. It is
  // logged, and the request waits in `leads` either way.
  try {
    const sent = await emailNewLead(lead, new Date());
    if (!sent) console.warn('lead saved; no email sent because EMAIL_API_KEY is not set');
  } catch (error) {
    console.error('lead saved; email failed', error);
  }

  return reply(request, { ok: true });
}
