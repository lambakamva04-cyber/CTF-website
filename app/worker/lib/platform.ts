// Rules for the CTF admin console, kept free of D1 so they can be tested
// directly. Anything here that decides who may do what is enforced on the
// server; the SPA reads the same answers only to hide what it would be refused.

import type { AccountStanding, OrgStanding } from '../../shared/types';
import type { OrgRow, UserRow } from './db';

/**
 * Admin sessions are far shorter than client sessions. A client leaving the
 * dashboard open on a front-desk PC all day is normal; an account that can
 * suspend every client on the platform should not stay signed in unattended.
 */
export const ADMIN_IDLE_TTL_MS = 30 * 60 * 1000;
export const ADMIN_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * How long a fresh authenticator code authorises destructive console actions.
 * Long enough to suspend a client and disable two of its logins in one sitting,
 * short enough that a session left open is not a loaded weapon.
 */
export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

export function isSteppedUp(steppedUpUntil: number | null | undefined, now = Date.now()): boolean {
  return typeof steppedUpUntil === 'number' && steppedUpUntil > now;
}

/** The addresses CTF itself signs in with. Clients may not use them. */
const CTF_GMAIL = 'cutthroughfaster@gmail.com';
const CTF_DOMAIN = 'cutthroughfaster.com';

/**
 * Gmail delivers `c.u.t.through+x@gmail.com` to the same inbox as
 * `cutthrough@gmail.com`, so compare on the address Gmail would deliver to.
 * Other providers are left exactly as typed: dots and plus tags are
 * significant there.
 */
export function canonicalEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 1) return lower;
  const local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const withoutTag = local.split('+', 1)[0] ?? local;
    return `${withoutTag.replace(/\./g, '')}@gmail.com`;
  }
  return lower;
}

/**
 * True for any address that belongs to CTF: the company Gmail inbox in any of
 * its spellings, and anything at cutthroughfaster.com or a subdomain of it.
 *
 * Clients are refused these when adding a login or signing up. Otherwise a
 * client's owner could create `hello@cutthroughfaster.com` inside their own
 * organization before CTF does, and a later grant of admin by email would hand
 * CTF control to a login whose password the client chose.
 */
export function isReservedCtfAddress(email: string): boolean {
  const canonical = canonicalEmail(email);
  if (canonical === CTF_GMAIL) return true;
  const domain = canonical.slice(canonical.lastIndexOf('@') + 1);
  return domain === CTF_DOMAIN || domain.endsWith(`.${CTF_DOMAIN}`);
}

export function orgStanding(org: Pick<OrgRow, 'status' | 'blocked_at'>): OrgStanding {
  if (org.blocked_at !== null && org.blocked_at !== undefined) return 'blocked';
  return org.status;
}

export function accountStanding(
  user: Pick<UserRow, 'disabled' | 'platform_hold'>,
  org: OrgStanding,
): AccountStanding {
  if (user.platform_hold === 'blocked' || org === 'blocked') return 'blocked';
  if (user.disabled === 1) return 'disabled';
  if (org !== 'active') return 'inactive';
  return 'active';
}

/**
 * Every enforcement action carries a reason, because six months later nobody
 * will remember why a client was suspended, and the client will ask.
 */
export function parseReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const reason = value.trim().replace(/\s+/g, ' ');
  if (reason.length < 3 || reason.length > 300) return null;
  return reason;
}

/**
 * The audit actions the activity feed shows, and the fixed label for each.
 *
 * An allowlist rather than a blocklist, and the raw `detail` column is never
 * shown: several actions store an email address or a staff phone number there,
 * and the feed is meant to say what happened, not to whom. Call actions are
 * absent on purpose — call volume is already visible as counts, and the feed
 * is about accounts, not conversations.
 */
export const ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  'auth.login': 'Signed in',
  'auth.login.google': 'Signed in with Google',
  'auth.logout': 'Signed out',
  'auth.password_changed': 'Changed password',
  'users.create': 'Added a login',
  'users.disable': 'Disabled a login',
  'users.update': 'Changed a login',
  'users.reset_password': 'Reset a password',
  'org.signup': 'Signed up, waiting for approval',
  '2fa.enabled': 'Turned on two-factor sign-in',
  '2fa.disabled': 'Turned off two-factor sign-in',
  '2fa.backup_code_used': 'Used a backup code',
  'platform.org_active': 'Activated the organization',
  'platform.org_pending': 'Returned the organization to pending',
  'platform.org_suspended': 'Suspended the organization',
  'platform.org_blocked': 'Blocked the organization',
  'platform.user_disabled': 'Disabled a login',
  'platform.user_enabled': 'Re-enabled a login',
  'platform.user_blocked': 'Blocked a login',
};

export const ACTIVITY_ACTIONS: readonly string[] = Object.keys(ACTIVITY_LABELS);

export function activityLabel(action: string): string | null {
  return ACTIVITY_LABELS[action] ?? null;
}
