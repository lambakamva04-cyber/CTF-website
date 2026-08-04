import type { Env } from '../env';
import type { OrgRow, UserRow } from './db';
import { newId, randomToken, sha256Hex } from './crypto';
import { clientIp, tooManyRequests, unauthorized } from './http';

export const SESSION_COOKIE = 'ctf_session';

/** Signed out after this long without activity. */
const IDLE_TTL_MS = 12 * 60 * 60 * 1000;
/** Hard ceiling regardless of activity — forces a fresh password check. */
const ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_EMAIL = 8;
const MAX_FAILURES_PER_IP = 30;

export interface AuthContext {
  user: UserRow;
  org: OrgRow;
  sessionId: string;
}

export function pbkdf2Iterations(env: Env): number | undefined {
  const raw = env.PBKDF2_ITERATIONS;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 10_000 ? parsed : undefined;
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  return attrs.join('; ');
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function createSession(
  env: Env,
  request: Request,
  userId: string,
): Promise<{ token: string; maxAgeSeconds: number }> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      userId,
      now,
      now + IDLE_TTL_MS,
      now,
      request.headers.get('user-agent')?.slice(0, 256) ?? null,
      clientIp(request),
    )
    .run();

  return { token, maxAgeSeconds: Math.floor(IDLE_TTL_MS / 1000) };
}

export async function destroySession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
}

/**
 * Resolves the session cookie to a user + org, sliding the idle expiry forward.
 * Throws 401 for anything expired, revoked, or belonging to a disabled user.
 */
export async function requireAuth(request: Request, env: Env): Promise<AuthContext> {
  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (!token) throw unauthorized('You are not signed in.');

  const sessionId = await sha256Hex(token);
  const now = Date.now();

  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.created_at AS session_created_at, s.expires_at,
            u.*, o.id AS o_id, o.name AS o_name, o.slug AS o_slug, o.timezone AS o_timezone,
            o.services AS o_services, o.vapi_assistant_id AS o_assistant,
            o.vapi_phone_number_id AS o_phone_number, o.takeover_number AS o_takeover,
            o.created_at AS o_created_at, o.updated_at AS o_updated_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN organizations o ON o.id = u.org_id
      WHERE s.id = ?`,
  )
    .bind(sessionId)
    .first<Record<string, unknown>>();

  if (!row) throw unauthorized('Your session has expired.');

  const expiresAt = row.expires_at as number;
  const sessionCreatedAt = row.session_created_at as number;

  if (expiresAt <= now || sessionCreatedAt + ABSOLUTE_TTL_MS <= now) {
    await destroySession(env, sessionId);
    throw unauthorized('Your session has expired.');
  }
  if ((row.disabled as number) === 1) {
    await destroySession(env, sessionId);
    throw unauthorized('This account has been disabled.');
  }

  // Slide the idle window, but only once a minute to avoid a write per poll.
  if (now - (row.last_seen_at as number ?? 0) > 60_000 || expiresAt - now < IDLE_TTL_MS / 2) {
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .bind(now, now + IDLE_TTL_MS, sessionId)
      .run();
  }

  const user: UserRow = {
    id: row.id as string,
    org_id: row.org_id as string,
    email: row.email as string,
    name: row.name as string,
    role: row.role as 'owner' | 'staff',
    phone: (row.phone as string | null) ?? null,
    password_hash: row.password_hash as string,
    must_change_password: row.must_change_password as number,
    disabled: row.disabled as number,
    last_login_at: (row.last_login_at as number | null) ?? null,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };

  const org: OrgRow = {
    id: row.o_id as string,
    name: row.o_name as string,
    slug: row.o_slug as string,
    timezone: row.o_timezone as string,
    services: row.o_services as string,
    vapi_assistant_id: (row.o_assistant as string | null) ?? null,
    vapi_phone_number_id: (row.o_phone_number as string | null) ?? null,
    takeover_number: (row.o_takeover as string | null) ?? null,
    created_at: row.o_created_at as number,
    updated_at: row.o_updated_at as number,
  };

  return { user, org, sessionId };
}

export async function assertLoginAllowed(env: Env, email: string, ip: string): Promise<void> {
  const since = Date.now() - LOGIN_WINDOW_MS;

  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN email = ?1 THEN 1 ELSE 0 END) AS by_email,
       SUM(CASE WHEN ip = ?2 THEN 1 ELSE 0 END) AS by_ip
     FROM login_attempts
     WHERE successful = 0 AND created_at > ?3 AND (email = ?1 OR ip = ?2)`,
  )
    .bind(email, ip, since)
    .first<{ by_email: number | null; by_ip: number | null }>();

  const byEmail = row?.by_email ?? 0;
  const byIp = row?.by_ip ?? 0;

  if (byEmail >= MAX_FAILURES_PER_EMAIL || byIp >= MAX_FAILURES_PER_IP) {
    throw tooManyRequests(
      'Too many sign-in attempts. Please wait 15 minutes and try again.',
      Math.ceil(LOGIN_WINDOW_MS / 1000),
    );
  }
}

export async function recordLoginAttempt(
  env: Env,
  email: string,
  ip: string,
  successful: boolean,
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO login_attempts (email, ip, successful, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(email, ip, successful ? 1 : 0, Date.now())
    .run();
}

/** Housekeeping so the auth tables do not grow without bound. */
export async function pruneExpired(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM login_attempts WHERE created_at < ?').bind(now - LOGIN_WINDOW_MS * 4),
    env.DB.prepare('DELETE FROM webhook_events WHERE received_at < ?').bind(now - 24 * 60 * 60 * 1000),
  ]);
}

export { newId, IDLE_TTL_MS };
