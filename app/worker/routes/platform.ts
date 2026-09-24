import type {
  AccountAction,
  AdminAccount,
  AdminAccountsResponse,
  AdminActivityItem,
  AdminActivityResponse,
  AdminClient,
  AdminNotice,
  AdminNoticeKind,
  AdminNoticesResponse,
  AdminOverview,
  AdminPeriod,
  OrgAction,
  StepUpResponse,
  UserRole,
} from '../../shared/types';
import type { Env } from '../env';
import type { AuthContext } from '../lib/auth';
import { BILLABLE_MINUTES_SQL, summariseBilling } from '../lib/billing';
import { writeAudit, type OrgRow, type UserRow } from '../lib/db';
import {
  badRequest,
  clientIp,
  conflict,
  forbidden,
  HttpError,
  json,
  notFound,
  readJson,
} from '../lib/http';
import {
  ACTIVITY_ACTIONS,
  STEP_UP_WINDOW_MS,
  accountStanding,
  activityLabel,
  canonicalEmail,
  isSteppedUp,
  orgStanding,
  parseReason,
} from '../lib/platform';
import { decryptSecret } from '../lib/secretbox';
import { isValidTimeZone, startOfLocalMonth } from '../lib/time';
import { verifyTotp } from '../lib/totp';
import { methodFor } from '../lib/twoFactor';

/**
 * The CTF admin console.
 *
 * Nothing in this file selects a caller's name, telephone number, transcript
 * or recording. What CTF oversees is accounts and counts, and the way to keep
 * that true is for these queries to be incapable of returning anything more.
 */

/**
 * A CTF admin with an authenticator app. Anyone else gets the same 404 as a
 * route that does not exist, so the console's existence is not advertised.
 * worker/index.ts applies the same authenticator rule before any route runs;
 * this is the second lock on the same door.
 */
export function requirePlatformAdmin(auth: AuthContext): void {
  if (auth.user.platform_role !== 'ctf_admin') throw notFound('That endpoint does not exist.');
  if (methodFor(auth.user) !== 'totp') {
    throw forbidden('Set up an authenticator app before using the CTF console.');
  }
}

/** Destructive actions need a code entered in the last few minutes. */
function requireStepUp(auth: AuthContext): void {
  if (!isSteppedUp(auth.steppedUpUntil)) {
    throw new HttpError(
      403,
      'step_up_required',
      'Enter a code from your authenticator app to confirm this action.',
    );
  }
}

function periodBounds(period: AdminPeriod, timeZone: string, now: Date): { from: number; to: number } {
  // Each client's month runs in its own timezone, exactly as its own billing
  // screen computes it, so the two can never show different minutes.
  const zone = isValidTimeZone(timeZone) ? timeZone : 'Africa/Johannesburg';
  const thisMonth = startOfLocalMonth(now, zone);
  if (period === 'this-month') return { from: thisMonth, to: Number.MAX_SAFE_INTEGER };
  return { from: startOfLocalMonth(new Date(thisMonth - 1), zone), to: thisMonth };
}

type ClientRow = OrgRow & {
  logins: number;
  active_logins: number;
  last_sign_in_at: number | null;
};

// ---------------------------------------------------------------------------
// Oversight
// ---------------------------------------------------------------------------

export async function handleAdminOverview(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  requirePlatformAdmin(auth);

  const period: AdminPeriod =
    new URL(request.url).searchParams.get('period') === 'last-month' ? 'last-month' : 'this-month';
  const now = new Date();

  // CTF's own organization is the operator, not a client: it never appears.
  const { results: orgs = [] } = await env.DB.prepare(
    `SELECT o.*,
            (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id)                   AS logins,
            (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id AND u.disabled = 0) AS active_logins,
            (SELECT MAX(u.last_login_at) FROM users u WHERE u.org_id = o.id)       AS last_sign_in_at
       FROM organizations o
      WHERE o.is_platform = 0
      ORDER BY o.created_at ASC`,
  ).all<ClientRow>();

  // One aggregate per client, each bounded by that client's own month. The
  // per-call rounding is the same rule as the client's billing screen:
  // BILLABLE_MINUTES_SQL is pinned to billableMinutesForCall by a test.
  const usage = orgs.length
    ? await env.DB.batch<{ calls: number; booked: number; minutes: number }>(
        orgs.map((org) => {
          const { from, to } = periodBounds(period, org.timezone, now);
          return env.DB.prepare(
            `SELECT COUNT(*) AS calls,
                    COALESCE(SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END), 0) AS booked,
                    COALESCE(SUM(${BILLABLE_MINUTES_SQL}), 0) AS minutes
               FROM calls
              WHERE org_id = ? AND started_at >= ? AND started_at < ?`,
          ).bind(org.id, from, to);
        }),
      )
    : [];

  const clients: AdminClient[] = orgs.map((org, index) => {
    const row = usage[index]?.results?.[0];
    const calls = row?.calls ?? 0;
    const booked = row?.booked ?? 0;
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      standing: orgStanding(org),
      statusReason: org.status_reason,
      createdAt: org.created_at,
      activatedAt: org.activated_at,
      logins: org.logins ?? 0,
      activeLogins: org.active_logins ?? 0,
      lastSignInAt: org.last_sign_in_at ?? null,
      calls,
      booked,
      bookingRate: calls > 0 ? Math.round((booked / calls) * 100) : 0,
      billing: summariseBilling(row?.minutes ?? 0, {
        planMinutes: org.plan_minutes,
        subscriptionZar: org.subscription_zar,
        overageRateZar: org.overage_rate_zar,
      }),
    };
  });

  const count = (standing: AdminClient['standing']) =>
    clients.filter((client) => client.standing === standing).length;
  const sum = (pick: (client: AdminClient) => number) =>
    clients.reduce((total, client) => total + pick(client), 0);

  const payload: AdminOverview = {
    period,
    clients,
    totals: {
      clients: clients.length,
      active: count('active'),
      pending: count('pending'),
      suspended: count('suspended'),
      blocked: count('blocked'),
      calls: sum((client) => client.calls),
      booked: sum((client) => client.booked),
      minutesUsed: sum((client) => client.billing.minutesUsed),
      extraMinutes: sum((client) => client.billing.extraMinutes),
      // Summed from each client's cents-rounded figure, then rounded again so
      // float addition cannot leave R0.30000000000000004 on the screen.
      extraCostZar: Math.round(sum((client) => client.billing.extraCostZar) * 100) / 100,
    },
  };

  return json(payload);
}

interface AccountRow {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  disabled: number;
  platform_hold: UserRow['platform_hold'];
  platform_hold_reason: string | null;
  last_login_at: number | null;
  created_at: number;
  org_id: string;
  org_name: string;
  org_status: OrgRow['status'];
  org_blocked_at: number | null;
}

/** Every client login on the platform. CTF's own logins are not listed. */
export async function handleAdminAccounts(env: Env, auth: AuthContext): Promise<Response> {
  requirePlatformAdmin(auth);

  // Columns named one by one: this query must never be widened into u.*, which
  // would carry password hashes and authenticator secrets into a response.
  const { results: rows = [] } = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.disabled, u.platform_hold, u.platform_hold_reason,
            u.last_login_at, u.created_at,
            o.id AS org_id, o.name AS org_name, o.status AS org_status, o.blocked_at AS org_blocked_at
       FROM users u
       JOIN organizations o ON o.id = u.org_id
      WHERE o.is_platform = 0 AND u.platform_role = 'none'
      ORDER BY o.name COLLATE NOCASE, u.role DESC, u.created_at ASC`,
  ).all<AccountRow>();

  const accounts: AdminAccount[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    orgId: row.org_id,
    orgName: row.org_name,
    standing: accountStanding(
      row,
      orgStanding({ status: row.org_status, blocked_at: row.org_blocked_at }),
    ),
    holdReason: row.platform_hold ? row.platform_hold_reason : null,
    lastSignInAt: row.last_login_at,
    createdAt: row.created_at,
  }));

  const active = accounts.filter((account) => account.standing === 'active').length;
  const payload: AdminAccountsResponse = {
    accounts,
    totals: { total: accounts.length, active, inactive: accounts.length - active },
  };
  return json(payload);
}

const ACTIVITY_PAGE = 50;

/**
 * What has been happening on the platform, newest first. Only allowlisted
 * actions, each with a fixed label; the audit log's free-text detail column is
 * never read here, because several actions store an address or a phone number
 * in it.
 */
export async function handleAdminActivity(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  requirePlatformAdmin(auth);

  const cursor = Number(new URL(request.url).searchParams.get('before'));
  const before = Number.isSafeInteger(cursor) && cursor > 0 ? cursor : Number.MAX_SAFE_INTEGER;
  const placeholders = ACTIVITY_ACTIONS.map(() => '?').join(', ');

  const { results: rows = [] } = await env.DB.prepare(
    `SELECT a.id, a.action, a.created_at,
            o.name AS org_name, o.is_platform AS org_is_platform,
            u.name AS actor_name, u.platform_role AS actor_role
       FROM audit_log a
       LEFT JOIN organizations o ON o.id = a.org_id
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.id < ? AND a.action IN (${placeholders})
      ORDER BY a.id DESC
      LIMIT ?`,
  )
    .bind(before, ...ACTIVITY_ACTIONS, ACTIVITY_PAGE + 1)
    .all<{
      id: number;
      action: string;
      created_at: number;
      org_name: string | null;
      org_is_platform: number | null;
      actor_name: string | null;
      actor_role: string | null;
    }>();

  const page = rows.slice(0, ACTIVITY_PAGE);
  const items: AdminActivityItem[] = page.map((row) => ({
    id: row.id,
    at: row.created_at,
    label: activityLabel(row.action) ?? row.action,
    // An admin's own sign-in is filed against CTF's organization; showing that
    // name would read as if CTF were a client.
    orgName: row.org_is_platform === 1 ? null : row.org_name,
    actorName: row.actor_name,
    byCtf: row.actor_role === 'ctf_admin',
  }));

  const payload: AdminActivityResponse = {
    items,
    nextCursor: rows.length > ACTIVITY_PAGE ? (page[page.length - 1]?.id ?? null) : null,
  };
  return json(payload);
}

export async function handleAdminNotices(env: Env, auth: AuthContext): Promise<Response> {
  requirePlatformAdmin(auth);

  const [unread, recent] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS count FROM platform_notifications WHERE read_at IS NULL'),
    env.DB.prepare(
      `SELECT id, kind, summary, created_at, read_at
         FROM platform_notifications
        ORDER BY id DESC
        LIMIT 30`,
    ),
  ]);

  const items: AdminNotice[] = (
    (recent?.results ?? []) as {
      id: number;
      kind: AdminNoticeKind;
      summary: string;
      created_at: number;
      read_at: number | null;
    }[]
  ).map((row) => ({
    id: row.id,
    kind: row.kind,
    summary: row.summary,
    at: row.created_at,
    read: row.read_at !== null,
  }));

  const payload: AdminNoticesResponse = {
    unread: ((unread?.results?.[0] as { count?: number } | undefined)?.count ?? 0) as number,
    items,
  };
  return json(payload);
}

export async function handleAdminNoticesRead(env: Env, auth: AuthContext): Promise<Response> {
  requirePlatformAdmin(auth);
  await env.DB.prepare('UPDATE platform_notifications SET read_at = ? WHERE read_at IS NULL')
    .bind(Date.now())
    .run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Re-verification
// ---------------------------------------------------------------------------

/**
 * Opens a five-minute window in which this session may suspend, disable and
 * block. A stolen cookie alone can look at the console but cannot act.
 */
export async function handleAdminStepUp(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  requirePlatformAdmin(auth);
  if (!auth.user.totp_secret) {
    throw forbidden('Set up an authenticator app before using the CTF console.');
  }

  const body = await readJson<{ code?: unknown }>(request);
  const code = typeof body.code === 'string' ? body.code : '';

  const secret = await decryptSecret(env, auth.user.totp_secret);
  const result = await verifyTotp(secret, code, {
    lastUsedCounter: auth.user.totp_last_counter ?? null,
  });

  if (!result.valid) {
    await writeAudit(env.DB, {
      orgId: auth.org.id,
      userId: auth.user.id,
      action: 'platform.step_up_failed',
      ip: clientIp(request),
    });
    throw badRequest(
      result.reused
        ? 'That code has already been used. Wait for your app to show the next one.'
        : 'That code is not correct.',
    );
  }

  // Spend the step with a compare-and-set: of two requests racing with the
  // same code, exactly one changes the row, and only that one is let through.
  const spent = await env.DB.prepare(
    `UPDATE users SET totp_last_counter = ?
      WHERE id = ? AND (totp_last_counter IS NULL OR totp_last_counter < ?)`,
  )
    .bind(result.counter, auth.user.id, result.counter)
    .run();
  if ((spent.meta?.changes ?? 0) !== 1) {
    throw badRequest('That code has already been used. Wait for your app to show the next one.');
  }

  const steppedUpUntil = Date.now() + STEP_UP_WINDOW_MS;
  await env.DB.prepare('UPDATE sessions SET stepped_up_until = ? WHERE id = ?')
    .bind(steppedUpUntil, auth.sessionId)
    .run();

  await writeAudit(env.DB, {
    orgId: auth.org.id,
    userId: auth.user.id,
    action: 'platform.step_up',
    ip: clientIp(request),
  });

  return json({ steppedUpUntil } satisfies StepUpResponse);
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

function parseOrgAction(value: unknown): OrgAction {
  if (value === 'activate' || value === 'suspend' || value === 'block') return value;
  throw badRequest('Action must be activate, suspend or block.');
}

function parseAccountAction(value: unknown): AccountAction {
  if (value === 'disable' || value === 'enable' || value === 'block') return value;
  throw badRequest('Action must be disable, enable or block.');
}

function requireReason(value: unknown): string {
  const reason = parseReason(value);
  if (!reason) throw badRequest('Give a reason, between 3 and 300 characters.');
  return reason;
}

/**
 * Activates, suspends or blocks a client organization.
 *
 *  - suspend: every login is signed out and kept out; reversible. For unpaid
 *    subscriptions and anything that needs to stop now but may be resolved.
 *  - block: permanent. Every login is disabled, every address the organization
 *    used is barred from signing up again, and the console will not undo it.
 *  - activate: approves a pending signup or lifts a suspension.
 */
export async function handleAdminOrgAction(
  request: Request,
  env: Env,
  auth: AuthContext,
  orgId: string,
): Promise<Response> {
  requirePlatformAdmin(auth);
  requireStepUp(auth);

  const body = await readJson<{ action?: unknown; reason?: unknown }>(request);
  const action = parseOrgAction(body.action);

  const org = await env.DB.prepare('SELECT * FROM organizations WHERE id = ?')
    .bind(orgId)
    .first<OrgRow>();
  if (!org) throw notFound('That organization could not be found.');
  if (org.is_platform === 1) {
    throw forbidden('Cut Through Faster’s own organization cannot be changed from the console.');
  }
  if (org.blocked_at !== null) {
    throw conflict('This organization is blocked. A block cannot be undone from the console.');
  }

  const now = Date.now();
  const revokeSessions = env.DB.prepare(
    'DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE org_id = ?)',
  ).bind(orgId);
  let reason: string | null = null;

  if (action === 'activate') {
    if (org.status === 'active') throw conflict('This organization is already active.');
    reason = parseReason(body.reason);
    await env.DB.prepare(
      `UPDATE organizations
          SET status = 'active', status_reason = NULL,
              activated_at = COALESCE(activated_at, ?), activated_by = ?, updated_at = ?
        WHERE id = ?`,
    )
      .bind(now, auth.user.id, now, orgId)
      .run();
  } else if (action === 'suspend') {
    if (org.status === 'suspended') throw conflict('This organization is already suspended.');
    reason = requireReason(body.reason);
    // One batch, so a suspension cannot land without its sign-outs.
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE organizations SET status = 'suspended', status_reason = ?, updated_at = ?
          WHERE id = ?`,
      ).bind(reason, now, orgId),
      revokeSessions,
    ]);
  } else {
    reason = requireReason(body.reason);
    const { results: members = [] } = await env.DB.prepare(
      'SELECT email FROM users WHERE org_id = ?',
    )
      .bind(orgId)
      .all<{ email: string }>();
    const blockedReason = reason;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE organizations
            SET status = 'suspended', blocked_at = ?, status_reason = ?, updated_at = ?
          WHERE id = ?`,
      ).bind(now, blockedReason, now, orgId),
      env.DB.prepare(
        `UPDATE users
            SET disabled = 1, platform_hold = 'blocked', platform_hold_at = ?,
                platform_hold_reason = ?, updated_at = ?
          WHERE org_id = ?`,
      ).bind(now, blockedReason, now, orgId),
      ...members.map((member) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO blocked_emails (email, reason, org_id, blocked_by, blocked_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(canonicalEmail(member.email), blockedReason, orgId, auth.user.id, now),
      ),
      revokeSessions,
    ]);
  }

  const verb = action === 'activate' ? 'active' : action === 'suspend' ? 'suspended' : 'blocked';
  await writeAudit(env.DB, {
    orgId,
    userId: auth.user.id,
    action: `platform.org_${verb}`,
    target: orgId,
    detail: reason,
    ip: clientIp(request),
  });

  return json({ ok: true, id: orgId, standing: verb });
}

/**
 * Disables, re-enables or blocks one client login.
 *
 *  - disable: signed out and kept out; reversible here. The client's own owner
 *    cannot re-enable it — that is the point of CTF doing it.
 *  - enable: lifts a CTF disable only. A login the client disabled themselves
 *    is theirs to re-enable, not CTF's.
 *  - block: permanent, and the address is barred from the platform.
 */
export async function handleAdminAccountAction(
  request: Request,
  env: Env,
  auth: AuthContext,
  userId: string,
): Promise<Response> {
  requirePlatformAdmin(auth);
  requireStepUp(auth);

  const body = await readJson<{ action?: unknown; reason?: unknown }>(request);
  const action = parseAccountAction(body.action);

  const target = await env.DB.prepare(
    `SELECT u.id, u.org_id, u.email, u.disabled, u.platform_role, u.platform_hold,
            o.is_platform AS org_is_platform
       FROM users u
       JOIN organizations o ON o.id = u.org_id
      WHERE u.id = ?`,
  )
    .bind(userId)
    .first<
      Pick<UserRow, 'id' | 'org_id' | 'email' | 'disabled' | 'platform_role' | 'platform_hold'> & {
        org_is_platform: number;
      }
    >();
  if (!target) throw notFound('That login could not be found.');

  // Admin accounts are managed in the database, never from the console: one
  // compromised admin must not be able to lock the others out.
  if (target.platform_role === 'ctf_admin' || target.org_is_platform === 1) {
    throw forbidden('CTF accounts cannot be changed from the console.');
  }
  if (target.platform_hold === 'blocked') {
    throw conflict('This login is blocked. A block cannot be undone from the console.');
  }

  const now = Date.now();
  const revokeSessions = env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId);
  let reason: string | null = null;

  if (action === 'disable') {
    if (target.platform_hold === 'disabled') throw conflict('CTF has already disabled this login.');
    reason = requireReason(body.reason);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE users
            SET disabled = 1, platform_hold = 'disabled', platform_hold_at = ?,
                platform_hold_reason = ?, updated_at = ?
          WHERE id = ?`,
      ).bind(now, reason, now, userId),
      revokeSessions,
    ]);
  } else if (action === 'enable') {
    if (target.platform_hold !== 'disabled') {
      throw conflict(
        'Only a login CTF disabled can be re-enabled here. A login its own organization disabled is theirs to re-enable.',
      );
    }
    reason = parseReason(body.reason);
    await env.DB.prepare(
      `UPDATE users
          SET disabled = 0, platform_hold = NULL, platform_hold_at = NULL,
              platform_hold_reason = NULL, updated_at = ?
        WHERE id = ?`,
    )
      .bind(now, userId)
      .run();
  } else {
    reason = requireReason(body.reason);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE users
            SET disabled = 1, platform_hold = 'blocked', platform_hold_at = ?,
                platform_hold_reason = ?, updated_at = ?
          WHERE id = ?`,
      ).bind(now, reason, now, userId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO blocked_emails (email, reason, org_id, blocked_by, blocked_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(canonicalEmail(target.email), reason, target.org_id, auth.user.id, now),
      revokeSessions,
    ]);
  }

  const verb = action === 'disable' ? 'disabled' : action === 'enable' ? 'enabled' : 'blocked';
  await writeAudit(env.DB, {
    orgId: target.org_id,
    userId: auth.user.id,
    action: `platform.user_${verb}`,
    target: userId,
    detail: reason,
    ip: clientIp(request),
  });

  return json({ ok: true, id: userId, standing: verb });
}

/** True when this address, in any spelling Gmail treats as the same, is barred. */
export async function isBlockedEmail(env: Env, email: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 AS hit FROM blocked_emails WHERE email = ?')
    .bind(canonicalEmail(email))
    .first<{ hit: number }>();
  return row !== null;
}
