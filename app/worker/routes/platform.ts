import type {
  PlatformOverview,
  PlatformOrgSummary,
} from '../../shared/types';
import type { Env } from '../env';
import type { AuthContext } from '../lib/auth';
import { writeAudit, type OrgRow } from '../lib/db';
import { badRequest, clientIp, forbidden, json, notFound, readJson } from '../lib/http';

/**
 * The CTF master view.
 *
 * Every query here selects counts and nothing else. There is no code path in
 * this file that reads a caller's name, telephone number, transcript or
 * recording, and that is deliberate: the privacy policy tells clients this view
 * contains billing figures only, and the way to keep that true is for the
 * queries not to be capable of returning anything more.
 */
function requirePlatformAdmin(auth: AuthContext): void {
  if (auth.user.platform_role !== 'ctf_admin') {
    // Same 404-style opacity as tenant scoping: someone who is not CTF staff
    // learns nothing about whether this surface exists.
    throw forbidden('This area is for Cut Through Faster staff.');
  }
}

interface OrgAggregateRow {
  id: string;
  name: string;
  slug: string;
  status: 'pending' | 'active' | 'suspended';
  plan: string;
  billing_email: string | null;
  signup_note: string | null;
  created_at: number;
  activated_at: number | null;
  logins: number;
  calls: number;
  booked: number;
  escalated: number;
  missed: number;
  seconds: number;
  last_call_at: number | null;
}

function monthStart(offsetMonths: number): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1);
}

export async function handlePlatformOverview(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  requirePlatformAdmin(auth);

  const period = new URL(request.url).searchParams.get('period') ?? 'this-month';
  const from =
    period === 'all-time' ? 0 : period === 'last-month' ? monthStart(-1) : monthStart(0);
  const to = period === 'last-month' ? monthStart(0) : Number.MAX_SAFE_INTEGER;

  const rows = await env.DB.prepare(
    `SELECT o.id, o.name, o.slug, o.status, o.plan, o.billing_email, o.signup_note,
            o.created_at, o.activated_at,
            (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id AND u.disabled = 0) AS logins,
            COUNT(c.id)                                                    AS calls,
            SUM(CASE WHEN c.outcome = 'booked'    THEN 1 ELSE 0 END)       AS booked,
            SUM(CASE WHEN c.outcome = 'escalated' THEN 1 ELSE 0 END)       AS escalated,
            SUM(CASE WHEN c.outcome = 'missed'    THEN 1 ELSE 0 END)       AS missed,
            COALESCE(SUM(c.duration_s), 0)                                 AS seconds,
            MAX(c.started_at)                                              AS last_call_at
       FROM organizations o
       LEFT JOIN calls c
         ON c.org_id = o.id AND c.started_at >= ?1 AND c.started_at < ?2
      GROUP BY o.id
      ORDER BY calls DESC, o.created_at ASC`,
  )
    .bind(from, to)
    .all<OrgAggregateRow>();

  const organizations: PlatformOrgSummary[] = (rows.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    plan: row.plan,
    billingEmail: row.billing_email,
    signupNote: row.signup_note,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    logins: row.logins ?? 0,
    calls: row.calls ?? 0,
    booked: row.booked ?? 0,
    escalated: row.escalated ?? 0,
    missed: row.missed ?? 0,
    // Rounded up: a 20-second call is a billable minute.
    minutes: Math.ceil((row.seconds ?? 0) / 60),
    bookingRate: row.calls > 0 ? Math.round(((row.booked ?? 0) / row.calls) * 100) : 0,
    lastCallAt: row.last_call_at,
  }));

  const payload: PlatformOverview = {
    period: period === 'last-month' ? 'last-month' : period === 'all-time' ? 'all-time' : 'this-month',
    organizations,
    totals: {
      organizations: organizations.length,
      pending: organizations.filter((org) => org.status === 'pending').length,
      active: organizations.filter((org) => org.status === 'active').length,
      calls: organizations.reduce((sum, org) => sum + org.calls, 0),
      booked: organizations.reduce((sum, org) => sum + org.booked, 0),
      minutes: organizations.reduce((sum, org) => sum + org.minutes, 0),
    },
  };

  return json(payload);
}

/** Activates, suspends or re-activates a client organization. */
export async function handlePlatformSetOrgStatus(
  request: Request,
  env: Env,
  auth: AuthContext,
  orgId: string,
): Promise<Response> {
  requirePlatformAdmin(auth);

  const body = await readJson<{ status?: unknown; plan?: unknown }>(request);
  const status = body.status;
  if (status !== 'pending' && status !== 'active' && status !== 'suspended') {
    throw badRequest('Status must be pending, active or suspended.');
  }

  const org = await env.DB.prepare('SELECT * FROM organizations WHERE id = ?')
    .bind(orgId)
    .first<OrgRow>();
  if (!org) throw notFound('That organization could not be found.');

  const plan = typeof body.plan === 'string' && body.plan.trim() ? body.plan.trim() : org.plan;
  const now = Date.now();

  await env.DB.prepare(
    `UPDATE organizations
        SET status = ?, plan = ?,
            activated_at = CASE WHEN ? = 'active' AND activated_at IS NULL THEN ? ELSE activated_at END,
            activated_by = CASE WHEN ? = 'active' THEN ? ELSE activated_by END,
            updated_at = ?
      WHERE id = ?`,
  )
    .bind(status, plan, status, now, status, auth.user.id, now, orgId)
    .run();

  // Suspension has to bite immediately; leaving live sessions alone would mean
  // a suspended client keeps working until their cookie happens to expire.
  if (status === 'suspended') {
    await env.DB.prepare(
      'DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE org_id = ?)',
    )
      .bind(orgId)
      .run();
  }

  await writeAudit(env.DB, {
    orgId,
    userId: auth.user.id,
    action: `platform.org_${status}`,
    target: orgId,
    detail: `${org.name} -> ${status} (${plan})`,
    ip: clientIp(request),
  });

  return json({ ok: true, id: orgId, status, plan });
}
