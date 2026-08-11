import type { SignupStartResponse } from '../../shared/types';
import { PRIVACY_VERSION, TERMS_VERSION } from '../../shared/legal';
import type { Env } from '../env';
import { newId, randomToken } from '../lib/crypto';
import { UNUSABLE_PASSWORD_HASH, writeAudit, type OrgRow, type UserRow } from '../lib/db';
import { badRequest, clientIp, json, notFound, readJson } from '../lib/http';
import { buildAuthorizeUrl, googleConfigured, redirectUriFor } from '../lib/google';
import { enforce, SIGNUP_RULE } from '../lib/rateLimit';

const STATE_TTL_MS = 30 * 60 * 1000;
const MAX_ORG_NAME = 80;

export interface SignupPayload {
  orgName: string;
  note: string | null;
  termsVersion: string;
  privacyVersion: string;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'org'
  );
}

/**
 * Begins a signup. The organization name and the accepted policy versions are
 * stored server-side alongside the OAuth state rather than carried through the
 * browser, so neither can be altered between here and the callback.
 */
export async function handleSignupStart(request: Request, env: Env): Promise<Response> {
  if (!googleConfigured(env)) {
    throw notFound('Signing up is not available on this deployment yet.');
  }

  await enforce(
    env,
    `ip:${clientIp(request)}`,
    SIGNUP_RULE,
    'Too many signup attempts from this connection. Please try again later.',
  );

  const body = await readJson<{ orgName?: unknown; note?: unknown; accept?: unknown }>(request);
  const orgName = typeof body.orgName === 'string' ? body.orgName.trim() : '';
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;

  if (orgName.length < 2) throw badRequest('Enter the name of your business.');
  if (orgName.length > MAX_ORG_NAME) throw badRequest('That business name is too long.');
  // Consent is a precondition, not a checkbox we record after the fact.
  if (body.accept !== true) {
    throw badRequest('You need to accept the terms and privacy policy to continue.');
  }

  const url = new URL(request.url);
  const state = randomToken(32);
  const nonce = randomToken(32);
  const now = Date.now();

  const payload: SignupPayload = {
    orgName,
    note,
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
  };

  await env.DB.prepare(
    `INSERT INTO oauth_states (state, nonce, redirect_to, created_at, expires_at, signup_payload)
     VALUES (?, ?, NULL, ?, ?, ?)`,
  )
    .bind(state, nonce, now, now + STATE_TTL_MS, JSON.stringify(payload))
    .run();

  const response: SignupStartResponse = {
    authorizeUrl: buildAuthorizeUrl(env, { state, nonce, redirectUri: redirectUriFor(url) }),
  };
  return json(response);
}

export function parseSignupPayload(raw: string | null): SignupPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SignupPayload>;
    if (typeof parsed.orgName !== 'string' || !parsed.orgName.trim()) return null;
    return {
      orgName: parsed.orgName.trim(),
      note: typeof parsed.note === 'string' ? parsed.note : null,
      termsVersion: typeof parsed.termsVersion === 'string' ? parsed.termsVersion : 'unknown',
      privacyVersion: typeof parsed.privacyVersion === 'string' ? parsed.privacyVersion : 'unknown',
    };
  } catch {
    return null;
  }
}

/**
 * Creates a pending organization and its first owner, after Google has
 * confirmed the email address.
 *
 * The organization starts pending: the account exists and can be signed into,
 * but sees no call data until CTF activates it. That keeps self-service signup
 * from handing a stranger a working view of the platform.
 */
export async function createPendingOrganization(
  env: Env,
  request: Request,
  identity: { sub: string; email: string; name: string | null },
  payload: SignupPayload,
): Promise<{ org: OrgRow; user: UserRow }> {
  const now = Date.now();
  const orgId = newId('org');
  const userId = newId('usr');

  // A slug collision between two businesses with the same name is possible and
  // harmless, so it is suffixed rather than rejected — nobody should fail to
  // sign up because another practice shares their name.
  const baseSlug = slugify(payload.orgName);
  const taken = await env.DB.prepare('SELECT 1 AS hit FROM organizations WHERE slug = ?')
    .bind(baseSlug)
    .first<{ hit: number }>();
  const slug = taken ? `${baseSlug}-${randomToken(3).toLowerCase()}` : baseSlug;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO organizations (
         id, name, slug, timezone, services, status, plan,
         billing_email, signup_note, created_at, updated_at
       ) VALUES (?, ?, ?, 'Africa/Johannesburg', '[]', 'pending', 'standard', ?, ?, ?, ?)`,
    ).bind(orgId, payload.orgName, slug, identity.email, payload.note, now, now),

    // Google-only: no password is generated, so nothing has to be transmitted
    // to the new owner, and no hashing happens on the request path.
    env.DB.prepare(
      `INSERT INTO users (
         id, org_id, email, name, role, phone, password_hash,
         must_change_password, disabled, google_sub, google_linked_at,
         platform_role, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'owner', NULL, ?, 0, 0, ?, ?, 'none', ?, ?)`,
    ).bind(
      userId,
      orgId,
      identity.email,
      identity.name ?? identity.email,
      UNUSABLE_PASSWORD_HASH,
      identity.sub,
      now,
      now,
      now,
    ),
  ]);

  await recordConsent(env, request, {
    userId,
    orgId,
    termsVersion: payload.termsVersion,
    privacyVersion: payload.privacyVersion,
  });

  await writeAudit(env.DB, {
    orgId,
    userId,
    action: 'org.signup',
    target: orgId,
    detail: `${payload.orgName} (${identity.email}) — pending approval`,
    ip: clientIp(request),
  });

  const org = await env.DB.prepare('SELECT * FROM organizations WHERE id = ?')
    .bind(orgId)
    .first<OrgRow>();
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(userId)
    .first<UserRow>();

  if (!org || !user) throw new Error('signup row missing after insert');
  return { org, user };
}

/** Appends acceptance rows. Never updated in place — the history is the record. */
export async function recordConsent(
  env: Env,
  request: Request,
  input: { userId: string; orgId: string; termsVersion: string; privacyVersion: string },
): Promise<void> {
  const now = Date.now();
  const ip = clientIp(request);
  const agent = request.headers.get('user-agent')?.slice(0, 256) ?? null;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO terms_acceptances (user_id, org_id, document, version, accepted_at, ip, user_agent)
       VALUES (?, ?, 'terms', ?, ?, ?, ?)`,
    ).bind(input.userId, input.orgId, input.termsVersion, now, ip, agent),
    env.DB.prepare(
      `INSERT INTO terms_acceptances (user_id, org_id, document, version, accepted_at, ip, user_agent)
       VALUES (?, ?, 'privacy', ?, ?, ?, ?)`,
    ).bind(input.userId, input.orgId, input.privacyVersion, now, ip, agent),
  ]);
}

/** True when the user has accepted the current version of both documents. */
export async function hasCurrentConsent(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN document = 'terms'   AND version = ?2 THEN 1 ELSE 0 END) AS terms,
       SUM(CASE WHEN document = 'privacy' AND version = ?3 THEN 1 ELSE 0 END) AS privacy
     FROM terms_acceptances WHERE user_id = ?1`,
  )
    .bind(userId, TERMS_VERSION, PRIVACY_VERSION)
    .first<{ terms: number | null; privacy: number | null }>();

  return (row?.terms ?? 0) > 0 && (row?.privacy ?? 0) > 0;
}

export async function handleAcceptTerms(
  request: Request,
  env: Env,
  auth: { user: UserRow; org: OrgRow },
): Promise<Response> {
  await recordConsent(env, request, {
    userId: auth.user.id,
    orgId: auth.org.id,
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
  });
  return json({ ok: true, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION });
}
