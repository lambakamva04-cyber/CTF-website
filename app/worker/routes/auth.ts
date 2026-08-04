import type { MeResponse, SessionOrg, SessionUser } from '../../shared/types';
import type { Env } from '../env';
import type { AuthContext } from '../lib/auth';
import {
  assertLoginAllowed,
  clearedSessionCookie,
  createSession,
  destroySession,
  pbkdf2Iterations,
  recordLoginAttempt,
  sessionCookie,
} from '../lib/auth';
import { hashPassword, needsRehash, verifyPassword } from '../lib/crypto';
import { parseServices, writeAudit, type OrgRow, type UserRow } from '../lib/db';
import { badRequest, clientIp, json, noContent, readJson, unauthorized } from '../lib/http';

const MIN_PASSWORD_LENGTH = 12;

export function toSessionUser(user: UserRow): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    phone: user.phone,
    mustChangePassword: user.must_change_password === 1,
  };
}

export function toSessionOrg(org: OrgRow): SessionOrg {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    timezone: org.timezone,
    services: parseServices(org.services),
    takeoverNumber: org.takeover_number,
    receptionistLinked: Boolean(org.vapi_assistant_id ?? org.vapi_phone_number_id),
  };
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ email?: unknown; password?: unknown }>(request);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email || !password) throw badRequest('Enter your email address and password.');

  const ip = clientIp(request);
  await assertLoginAllowed(env, email, ip);

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?')
    .bind(email)
    .first<UserRow>();

  // Same generic message and comparable work for unknown users, wrong
  // passwords and disabled accounts, so the endpoint cannot enumerate clients.
  const storedHash =
    user?.password_hash ??
    'pbkdf2$sha256$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const passwordOk = await verifyPassword(password, storedHash);

  if (!user || !passwordOk || user.disabled === 1) {
    await recordLoginAttempt(env, email, ip, false);
    throw unauthorized('That email address and password do not match.');
  }

  const org = await env.DB.prepare('SELECT * FROM organizations WHERE id = ?')
    .bind(user.org_id)
    .first<OrgRow>();
  if (!org) throw unauthorized('Your account is not linked to a business yet.');

  const iterations = pbkdf2Iterations(env);
  if (needsRehash(user.password_hash, iterations)) {
    const upgraded = await hashPassword(password, iterations);
    await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .bind(upgraded, Date.now(), user.id)
      .run();
  }

  await recordLoginAttempt(env, email, ip, true);
  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .bind(Date.now(), user.id)
    .run();

  const { token, maxAgeSeconds } = await createSession(env, request, user.id);
  await writeAudit(env.DB, {
    orgId: org.id,
    userId: user.id,
    action: 'auth.login',
    ip,
  });

  const payload: MeResponse = { user: toSessionUser(user), org: toSessionOrg(org) };
  return json(payload, { headers: { 'set-cookie': sessionCookie(token, maxAgeSeconds) } });
}

export async function handleLogout(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  await destroySession(env, auth.sessionId);
  await writeAudit(env.DB, {
    orgId: auth.org.id,
    userId: auth.user.id,
    action: 'auth.logout',
    ip: clientIp(request),
  });
  return noContent({ headers: { 'set-cookie': clearedSessionCookie() } });
}

export function handleMe(auth: AuthContext): Response {
  const payload: MeResponse = { user: toSessionUser(auth.user), org: toSessionOrg(auth.org) };
  return json(payload);
}

export async function handleChangePassword(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const body = await readJson<{ currentPassword?: unknown; newPassword?: unknown }>(request);
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

  if (!(await verifyPassword(currentPassword, auth.user.password_hash))) {
    throw unauthorized('Your current password is not correct.');
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (newPassword === currentPassword) {
    throw badRequest('Choose a password you have not used here before.');
  }

  const hash = await hashPassword(newPassword, pbkdf2Iterations(env));
  const now = Date.now();

  // Changing a password signs every other device out, which is what a client
  // expects when they change it because they think someone else has it.
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?',
    ).bind(hash, now, auth.user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(
      auth.user.id,
      auth.sessionId,
    ),
  ]);

  await writeAudit(env.DB, {
    orgId: auth.org.id,
    userId: auth.user.id,
    action: 'auth.password_changed',
    ip: clientIp(request),
  });

  return noContent();
}

export { MIN_PASSWORD_LENGTH };
