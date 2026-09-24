import type { MeResponse } from '../../shared/types';
import type { Env } from '../env';
import type { AuthContext } from '../lib/auth';
import { createSession, sessionCookie } from '../lib/auth';
import { writeAudit, type OrgRow, type UserRow } from '../lib/db';
import { emailConfigured } from '../lib/email';
import { badRequest, clientIp, forbidden, json, notFound, readJson, unauthorized } from '../lib/http';
import { decryptSecret, encryptSecret, encryptionConfigured } from '../lib/secretbox';
import { generateSecret, otpauthUri, verifyTotp } from '../lib/totp';
import { toSessionOrg, toSessionUser } from './auth';
import {
  consumeBackupCode,
  countUnusedBackupCodes,
  discardChallenge,
  generateBackupCodes,
  loadChallenge,
  methodFor,
  replaceBackupCodes,
  startChallenge,
  verifyChallenge,
} from '../lib/twoFactor';

const ISSUER = 'Cut Through Faster';

/** What the account holder can see about their own second factor. */
export async function handleTwoFactorStatus(env: Env, auth: AuthContext): Promise<Response> {
  return json({
    method: methodFor(auth.user),
    /** An enrolment begun but never confirmed — the UI offers to resume it. */
    pendingTotp: Boolean(auth.user.totp_secret && !auth.user.totp_confirmed_at),
    backupCodesRemaining: await countUnusedBackupCodes(env, auth.user.id),
    totpAvailable: encryptionConfigured(env),
    emailAvailable: emailConfigured(env),
  });
}

/**
 * Step one of enrolment: issue a secret and the URI an app scans.
 *
 * The secret is stored immediately but unconfirmed, so a browser that dies
 * between the QR code and the first code does not strand the account. The
 * factor is not live until confirmation.
 */
export async function handleTotpEnrollStart(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  if (!encryptionConfigured(env)) {
    throw notFound('Two-factor authentication is not available on this deployment yet.');
  }
  if (methodFor(auth.user) === 'totp') {
    throw badRequest('An authenticator app is already set up. Turn it off first to re-enrol.');
  }

  const secret = generateSecret();
  await env.DB.prepare(
    'UPDATE users SET totp_secret = ?, totp_confirmed_at = NULL, updated_at = ? WHERE id = ?',
  )
    .bind(await encryptSecret(env, secret), Date.now(), auth.user.id)
    .run();

  await writeAudit(env.DB, {
    orgId: auth.org.id,
    userId: auth.user.id,
    action: '2fa.totp.enroll_started',
    target: auth.user.id,
    ip: clientIp(request),
  });

  return json({
    // Returned once, at enrolment, to the authenticated account holder. After
    // confirmation it is never readable again — not by this API, and not by
    // anyone with the database, because it is encrypted at rest.
    secret,
    otpauthUri: otpauthUri({ secret, account: auth.user.email, issuer: ISSUER }),
  });
}

/** Step two: prove an app can compute a code, then turn the factor on. */
export async function handleTotpEnrollConfirm(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const body = await readJson<{ code?: unknown }>(request);
  const code = typeof body.code === 'string' ? body.code : '';

  if (!auth.user.totp_secret) throw badRequest('Start setting up your authenticator app first.');

  const secret = await decryptSecret(env, auth.user.totp_secret);
  const result = await verifyTotp(secret, code);
  if (!result.valid) {
    throw badRequest(
      result.reused
        ? 'That code has already been used. Wait for the next one.'
        : 'That code is not correct. Check your app and try again.',
    );
  }

  const backupCodes = generateBackupCodes();
  await env.DB.prepare(
    `UPDATE users
        SET two_factor_method = 'totp', totp_confirmed_at = ?, totp_last_counter = ?,
            updated_at = ?
      WHERE id = ?`,
  )
    .bind(Date.now(), result.counter, Date.now(), auth.user.id)
    .run();
  await replaceBackupCodes(env, auth.user.id, backupCodes);

  await writeAudit(env.DB, {
    orgId: auth.org.id,
    userId: auth.user.id,
    action: '2fa.enabled',
    target: auth.user.id,
    detail: 'authenticator app',
    ip: clientIp(request),
  });

  // The only time these are ever shown. Regenerating is the only way to see a
  // set again, which is what makes "write these down now" true rather than
  // advice the user can ignore and recover from later.
  return json({ backupCodes });
}

/** Turns on the email factor for an account without an authenticator app. */
export async function handleEmailFactorEnable(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  // A code in an inbox is only as safe as the inbox. The account that can
  // suspend every client uses an authenticator app, and nothing weaker.
  if (auth.user.platform_role === 'ctf_admin') {
    throw forbidden('CTF admin accounts must use an authenticator app.');
  }
  if (!emailConfigured(env)) {
    throw notFound('Email codes are not available on this deployment yet.');
  }
  if (methodFor(auth.user) === 'totp') {
    throw badRequest('You already use an authenticator app, which is stronger than email codes.');
  }

  const backupCodes = generateBackupCodes();
  await env.DB.prepare(
    `UPDATE users SET two_factor_method = 'email', updated_at = ? WHERE id = ?`,
  )
    .bind(Date.now(), auth.user.id)
    .run();
  await replaceBackupCodes(env, auth.user.id, backupCodes);

  await writeAudit(env.DB, {
    orgId: auth.org.id,
    userId: auth.user.id,
    action: '2fa.enabled',
    target: auth.user.id,
    detail: 'email codes',
    ip: clientIp(request),
  });

  return json({ backupCodes });
}

/**
 * Turns the second factor off. Requires a current code, so someone who walks up
 * to an unlocked laptop cannot quietly remove it.
 */
export async function handleTwoFactorDisable(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  // Switching the factor off would re-open the console to a password alone.
  // A lost phone is recovered with a backup code, or by resetting the factor
  // in the database, never by turning it off from inside the account.
  if (auth.user.platform_role === 'ctf_admin') {
    throw forbidden('Two-factor sign-in cannot be turned off on a CTF admin account.');
  }
  const method = methodFor(auth.user);
  if (method === 'none') throw badRequest('Two-factor authentication is not switched on.');

  const body = await readJson<{ code?: unknown }>(request);
  const code = typeof body.code === 'string' ? body.code : '';

  if (method === 'totp') {
    if (!auth.user.totp_secret) throw badRequest('There is no authenticator app to turn off.');
    const secret = await decryptSecret(env, auth.user.totp_secret);
    const result = await verifyTotp(secret, code, {
      lastUsedCounter: auth.user.totp_last_counter ?? null,
    });
    if (!result.valid) {
      // A backup code is accepted here too: someone whose phone is lost needs a
      // way to switch the factor off, and they have already proved the first
      // factor to reach this endpoint at all.
      const viaBackup = await consumeBackupCode(env, request, auth.user, code);
      if (!viaBackup) {
        throw badRequest(
          result.reused
            ? 'That code has already been used. Wait for the next one.'
            : 'That code is not correct.',
        );
      }
    }
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users
          SET two_factor_method = 'none', totp_secret = NULL, totp_confirmed_at = NULL,
              totp_last_counter = NULL, updated_at = ?
        WHERE id = ?`,
    ).bind(Date.now(), auth.user.id),
    env.DB.prepare('DELETE FROM backup_codes WHERE user_id = ?').bind(auth.user.id),
  ]);

  await writeAudit(env.DB, {
    orgId: auth.org.id,
    userId: auth.user.id,
    action: '2fa.disabled',
    target: auth.user.id,
    detail: method,
    ip: clientIp(request),
  });

  return json({ ok: true });
}

export async function handleRegenerateBackupCodes(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  if (methodFor(auth.user) === 'none') {
    throw badRequest('Backup codes are only useful once two-factor is switched on.');
  }

  const backupCodes = generateBackupCodes();
  await replaceBackupCodes(env, auth.user.id, backupCodes);

  await writeAudit(env.DB, {
    orgId: auth.org.id,
    userId: auth.user.id,
    action: '2fa.backup_codes_regenerated',
    target: auth.user.id,
    ip: clientIp(request),
  });

  return json({ backupCodes });
}

/**
 * Answers a challenge and, if the code is right, issues the session.
 *
 * This is the only place outside the first-factor handlers that creates a
 * session, and it is unauthenticated by necessity — the caller has no cookie
 * yet. Everything it trusts comes from the challenge row, which the server
 * wrote, not from the request.
 */
export async function handleChallengeVerify(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ challengeId?: unknown; code?: unknown; backupCode?: unknown }>(
    request,
  );
  const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
  const code = typeof body.code === 'string' ? body.code : '';
  const backupCode = typeof body.backupCode === 'string' ? body.backupCode : '';

  if (!challengeId) throw unauthorized('That sign-in has expired. Please start again.');

  const challenge = await loadChallenge(env, challengeId);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(challenge.user_id)
    .first<UserRow>();

  if (!user || user.disabled === 1) {
    await discardChallenge(env, challengeId);
    throw unauthorized('That sign-in is no longer valid.');
  }

  if (backupCode) {
    const spent = await consumeBackupCode(env, request, user, backupCode);
    if (!spent) return json({ ok: false, message: 'That backup code is not valid.' }, { status: 400 });
    await discardChallenge(env, challengeId);
    await writeAudit(env.DB, {
      orgId: user.org_id,
      userId: user.id,
      action: '2fa.backup_code_used',
      target: user.id,
      detail: `${await countUnusedBackupCodes(env, user.id)} remaining`,
      ip: clientIp(request),
    });
  } else {
    const result = await verifyChallenge(env, challenge, user, code);
    if (!result.ok) {
      return json(
        { ok: false, message: result.message, attemptsLeft: result.attemptsLeft },
        { status: 400 },
      );
    }
  }

  const org = await env.DB.prepare('SELECT * FROM organizations WHERE id = ?')
    .bind(user.org_id)
    .first<OrgRow>();
  if (!org) throw unauthorized('Your account is not linked to a business yet.');

  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .bind(Date.now(), user.id)
    .run();

  const { token, maxAgeSeconds } = await createSession(env, request, user.id);
  await writeAudit(env.DB, {
    orgId: org.id,
    userId: user.id,
    action: 'auth.login',
    target: user.id,
    detail: `second factor: ${challenge.method}`,
    ip: clientIp(request),
  });

  // Consent is re-checked on the very next request by the router's gate, so it
  // is reported optimistically here rather than queried a second time.
  const payload: MeResponse = { user: toSessionUser(user), org: toSessionOrg(org) };
  return json(payload, { headers: { 'set-cookie': sessionCookie(token, maxAgeSeconds) } });
}

/** Re-sends an email code for a challenge already open. */
export async function handleChallengeResend(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ challengeId?: unknown }>(request);
  const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
  if (!challengeId) throw unauthorized('That sign-in has expired. Please start again.');

  const challenge = await loadChallenge(env, challengeId);
  if (challenge.method !== 'email') throw badRequest('This sign-in does not use email codes.');

  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(challenge.user_id)
    .first<UserRow>();
  if (!user || user.disabled === 1) throw unauthorized('That sign-in is no longer valid.');

  // A new challenge rather than a re-send of the same code: the old one is
  // discarded, so a code read off a screen minutes ago stops working.
  await discardChallenge(env, challengeId);
  const started = await startChallenge(env, request, user);
  return json(started);
}
