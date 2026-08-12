import type { SignupStartResponse } from '../../shared/types';
import {
  CURRENT_VERSIONS,
  OPERATOR_VERSION,
  PRIVACY_VERSION,
  TERMS_VERSION,
  type LegalDocumentId,
} from '../../shared/legal';
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
    throw badRequest(
      'You need to accept the terms, the privacy policy and the operator agreement to continue.',
    );
  }

  const url = new URL(request.url);
  const state = randomToken(32);
  const nonce = randomToken(32);
  const now = Date.now();

  const payload: SignupPayload = { orgName, note };

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

  await recordConsent(env, request, { userId, orgId });

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

/**
 * Appends one acceptance row per document. Never updated in place — the history
 * is the record, and a row that can be overwritten proves nothing about what
 * anyone agreed to.
 *
 * All three documents are recorded together because they are presented
 * together: the operator agreement is what POPIA section 72 relies on to permit
 * the data leaving South Africa, so a client who accepted only the other two
 * would leave that transfer without its legal basis.
 */
export async function recordConsent(
  env: Env,
  request: Request,
  input: { userId: string; orgId: string },
): Promise<void> {
  const now = Date.now();
  const ip = clientIp(request);
  const agent = request.headers.get('user-agent')?.slice(0, 256) ?? null;

  await env.DB.batch(
    (Object.keys(CURRENT_VERSIONS) as LegalDocumentId[]).map((document) =>
      env.DB.prepare(
        `INSERT INTO terms_acceptances (user_id, org_id, document, version, accepted_at, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(input.userId, input.orgId, document, CURRENT_VERSIONS[document], now, ip, agent),
    ),
  );
}

/** True when the user has accepted the current version of every document. */
export async function hasCurrentConsent(env: Env, userId: string): Promise<boolean> {
  const documents = Object.keys(CURRENT_VERSIONS) as LegalDocumentId[];

  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT document) AS accepted
       FROM terms_acceptances
      WHERE user_id = ?1
        AND ((document = 'terms'    AND version = ?2)
          OR (document = 'privacy'  AND version = ?3)
          OR (document = 'operator' AND version = ?4))`,
  )
    .bind(userId, TERMS_VERSION, PRIVACY_VERSION, OPERATOR_VERSION)
    .first<{ accepted: number | null }>();

  return (row?.accepted ?? 0) === documents.length;
}

export async function handleAcceptTerms(
  request: Request,
  env: Env,
  auth: { user: UserRow; org: OrgRow },
): Promise<Response> {
  await recordConsent(env, request, { userId: auth.user.id, orgId: auth.org.id });
  return json({
    ok: true,
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
    operatorVersion: OPERATOR_VERSION,
  });
}
