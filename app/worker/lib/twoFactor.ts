// The second factor, shared by both sign-in paths.
//
// The shape of the flow: the first factor (password, or Google) proves who you
// are; if the account has a second factor enabled, no session is created.
// Instead a row goes into `login_challenges` and the client gets an opaque
// challenge id. Only when the code is verified does a session cookie exist.
//
// A challenge grants nothing on its own. That is deliberate — the alternative,
// a "half authenticated" session cookie with a flag on it, means one missed
// check somewhere turns a first factor into a full login.

import type { Env } from '../env';
import { newId, randomToken, sha256Hex, timingSafeEqual } from './crypto';
import type { UserRow } from './db';
import { clientIp, tooManyRequests, unauthorized } from './http';
import { sendEmail, verificationCodeEmail } from './email';
import { decryptSecret } from './secretbox';
import { counterAt, verifyTotp } from './totp';

/** Long enough to fetch a phone from another room, short enough to matter. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const EMAIL_CODE_TTL_MINUTES = CHALLENGE_TTL_MS / 60_000;

/**
 * Wrong codes tolerated on one challenge before it is destroyed.
 *
 * Six digits is a million possibilities, so the per-challenge cap matters more
 * than the per-window rate limit: without it, an attacker who has the password
 * can sit on a single challenge and grind. Five is enough for fat fingers.
 */
export const MAX_CHALLENGE_ATTEMPTS = 5;

export type TwoFactorMethod = 'none' | 'totp' | 'email';

export interface ChallengeRow {
  id: string;
  user_id: string;
  method: 'totp' | 'email';
  code_hash: string | null;
  attempts: number;
  created_at: number;
  expires_at: number;
}

export function methodFor(user: UserRow): TwoFactorMethod {
  const method = user.two_factor_method ?? 'none';
  // A TOTP enrolment that was started and never confirmed is not a live factor.
  // Treating it as one would lock the account behind a secret whose owner never
  // proved they could compute a code from it.
  if (method === 'totp' && !user.totp_confirmed_at) return 'none';
  return method;
}

export function requiresSecondFactor(user: UserRow): boolean {
  return methodFor(user) !== 'none';
}

/** Six digits, uniformly. Rejection sampling, so no value is likelier. */
function sixDigitCode(): string {
  const bytes = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(bytes);
    value = bytes[0] as number;
    // 4294967295 is not a multiple of a million, so the tail of the range would
    // otherwise make low codes marginally more likely.
  } while (value >= Math.floor(4294967296 / 1_000_000) * 1_000_000);
  return (value % 1_000_000).toString().padStart(6, '0');
}

/**
 * Opens a challenge for a user who has passed the first factor.
 *
 * For the email method this sends the code. A send failure is surfaced to the
 * caller rather than swallowed: a challenge nobody can answer is worse than a
 * clear "we could not email you", which at least tells the client to call us.
 */
export async function startChallenge(
  env: Env,
  request: Request,
  user: UserRow,
): Promise<{ challengeId: string; method: 'totp' | 'email'; sentTo: string | null }> {
  const method = methodFor(user);
  if (method === 'none') throw new Error('startChallenge called for an account without 2FA');

  const now = Date.now();
  const id = newId('chl');
  const code = method === 'email' ? sixDigitCode() : null;

  await env.DB.prepare(
    `INSERT INTO login_challenges
       (id, user_id, method, code_hash, attempts, created_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      user.id,
      method,
      code ? await sha256Hex(code) : null,
      now,
      now + CHALLENGE_TTL_MS,
      clientIp(request),
      request.headers.get('user-agent')?.slice(0, 256) ?? null,
    )
    .run();

  if (method === 'email' && code) {
    const { subject, text } = verificationCodeEmail({
      code,
      minutesValid: EMAIL_CODE_TTL_MINUTES,
      ip: clientIp(request),
    });
    await sendEmail(env, { to: user.email, subject, text });
  }

  return {
    challengeId: id,
    method,
    // Masked, so a shoulder-surfer learns nothing the account holder does not
    // already know, but the client can still tell which inbox to check.
    sentTo: method === 'email' ? maskEmail(user.email) : null,
  };
}

/** `th****@ri******.co.za` — enough to recognise, not enough to harvest. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const head = local.slice(0, 2);
  const [name = '', ...rest] = domain.split('.');
  const maskedDomain = [name.slice(0, 2) + '*'.repeat(Math.max(0, name.length - 2)), ...rest].join(
    '.',
  );
  return `${head}${'*'.repeat(Math.max(0, local.length - 2))}@${maskedDomain}`;
}

export async function loadChallenge(env: Env, challengeId: string): Promise<ChallengeRow> {
  const row = await env.DB.prepare('SELECT * FROM login_challenges WHERE id = ?')
    .bind(challengeId)
    .first<ChallengeRow>();

  if (!row) throw unauthorized('That sign-in has expired. Please start again.');
  if (row.expires_at <= Date.now()) {
    await env.DB.prepare('DELETE FROM login_challenges WHERE id = ?').bind(challengeId).run();
    throw unauthorized('That sign-in has expired. Please start again.');
  }
  return row;
}

export async function discardChallenge(env: Env, challengeId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM login_challenges WHERE id = ?').bind(challengeId).run();
}

/**
 * Checks a submitted code against a challenge.
 *
 * On success the challenge is consumed, so the same one cannot be answered
 * twice. On the final failed attempt it is destroyed too — the client has to go
 * back through the first factor, which puts the per-account login limiter back
 * in the path.
 */
export async function verifyChallenge(
  env: Env,
  challenge: ChallengeRow,
  user: UserRow,
  submitted: string,
): Promise<{ ok: true } | { ok: false; message: string; attemptsLeft: number }> {
  const code = submitted.replace(/[\s-]/g, '');

  const fail = async (message: string) => {
    const attempts = challenge.attempts + 1;
    if (attempts >= MAX_CHALLENGE_ATTEMPTS) {
      await discardChallenge(env, challenge.id);
      throw tooManyRequests(
        'Too many incorrect codes. Please sign in again.',
        Math.ceil(CHALLENGE_TTL_MS / 1000),
      );
    }
    await env.DB.prepare('UPDATE login_challenges SET attempts = ? WHERE id = ?')
      .bind(attempts, challenge.id)
      .run();
    return {
      ok: false as const,
      message,
      attemptsLeft: MAX_CHALLENGE_ATTEMPTS - attempts,
    };
  };

  if (!/^\d{6}$/.test(code)) return fail('Enter the six-digit code.');

  if (challenge.method === 'email') {
    if (!challenge.code_hash) return fail('That code is not correct.');
    const matches = await timingSafeEqual(await sha256Hex(code), challenge.code_hash);
    if (!matches) return fail('That code is not correct.');
    await discardChallenge(env, challenge.id);
    return { ok: true };
  }

  if (!user.totp_secret) return fail('That code is not correct.');

  const secret = await decryptSecret(env, user.totp_secret);
  const result = await verifyTotp(secret, code, {
    lastUsedCounter: user.totp_last_counter ?? null,
  });
  if (!result.valid) {
    return fail(
      result.reused
        ? 'That code has already been used. Wait for your app to show the next one.'
        : 'That code is not correct.',
    );
  }

  // Record the step before granting the session, so a code cannot be spent
  // twice even by two requests arriving together.
  await env.DB.prepare('UPDATE users SET totp_last_counter = ? WHERE id = ?')
    .bind(result.counter, user.id)
    .run();
  await discardChallenge(env, challenge.id);
  return { ok: true };
}

/**
 * Spends a backup code. Separate from the code path above because these are the
 * way back in when the phone is gone, and they are single-use by construction.
 */
export async function consumeBackupCode(
  env: Env,
  request: Request,
  user: UserRow,
  submitted: string,
): Promise<boolean> {
  const normalised = submitted.trim().toLowerCase().replace(/[\s-]/g, '');
  if (!/^[a-z0-9]{10}$/.test(normalised)) return false;

  const hash = await sha256Hex(normalised);
  // Matched and marked used in one statement: two requests racing with the same
  // code cannot both come away with a session.
  const row = await env.DB.prepare(
    `UPDATE backup_codes SET used_at = ?, used_ip = ?
      WHERE id = (
        SELECT id FROM backup_codes
         WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
         LIMIT 1
      )
      RETURNING id`,
  )
    .bind(Date.now(), clientIp(request), user.id, hash)
    .first<{ id: number }>();

  return Boolean(row);
}

export function generateBackupCodes(count = 10): string[] {
  // Ten characters of base32-ish alphabet, no vowels, so no code spells
  // anything and O/0 and I/1 cannot be confused when read off paper.
  const alphabet = '23456789bcdfghjkmnpqrstvwxz';
  return Array.from({ length: count }, () => {
    const bytes = new Uint8Array(10);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  });
}

export async function replaceBackupCodes(
  env: Env,
  userId: string,
  codes: string[],
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM backup_codes WHERE user_id = ?').bind(userId),
    ...(await Promise.all(
      codes.map(async (code) =>
        env.DB.prepare(
          'INSERT INTO backup_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)',
        ).bind(userId, await sha256Hex(code), now),
      ),
    )),
  ]);
}

export async function countUnusedBackupCodes(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS remaining FROM backup_codes WHERE user_id = ? AND used_at IS NULL',
  )
    .bind(userId)
    .first<{ remaining: number }>();
  return row?.remaining ?? 0;
}

export { counterAt, randomToken };
