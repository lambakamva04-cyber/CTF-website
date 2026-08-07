import type {
  CreatedTeamMember,
  TeamMember,
  TeamResponse,
  UserRole,
} from '../../shared/types';
import type { Env } from '../env';
import type { AuthContext } from '../lib/auth';
import { newId, pbkdf2Iterations } from '../lib/auth';
import { hashPassword, randomToken } from '../lib/crypto';
import { UNUSABLE_PASSWORD_HASH, writeAudit, type UserRow } from '../lib/db';
import { badRequest, clientIp, conflict, json, notFound, readJson } from '../lib/http';
import { requirePermission } from '../lib/permissions';

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_MEMBERS_PER_ORG = 50;

function toTeamMember(row: UserRow, selfId: string): TeamMember {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    phone: row.phone,
    disabled: row.disabled === 1,
    googleLinked: row.google_sub !== null,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    isSelf: row.id === selfId,
  };
}

function parseRole(value: unknown): UserRole {
  if (value === 'owner' || value === 'staff') return value;
  throw badRequest('Role must be either owner or staff.');
}

export async function handleListTeam(env: Env, auth: AuthContext): Promise<Response> {
  requirePermission(auth.user.role, 'users:manage');

  const rows = await env.DB.prepare(
    'SELECT * FROM users WHERE org_id = ? ORDER BY disabled ASC, created_at ASC',
  )
    .bind(auth.org.id)
    .all<UserRow>();

  const payload: TeamResponse = {
    members: (rows.results ?? []).map((row) => toTeamMember(row, auth.user.id)),
  };
  return json(payload);
}

export async function handleCreateTeamMember(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  requirePermission(auth.user.role, 'users:manage');

  const body = await readJson<{
    email?: unknown;
    name?: unknown;
    role?: unknown;
    phone?: unknown;
    signInMethod?: unknown;
  }>(request);

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const role = parseRole(body.role ?? 'staff');
  const phone = typeof body.phone === 'string' && body.phone.trim() ? body.phone.trim() : null;

  // Google-only logins skip password hashing entirely. That is not just a
  // convenience: hashing costs 210,000 PBKDF2 iterations, which exceeds the
  // Workers Free CPU budget for a single request, so on that plan creating a
  // password login fails outright. It is also the safer default — no temporary
  // password to transmit, and nothing to leak if it is mishandled.
  const googleOnly = body.signInMethod !== 'password';

  if (!EMAIL_PATTERN.test(email)) throw badRequest('Enter a valid email address.');
  if (!name) throw badRequest('Enter the person’s name.');

  const existing = await env.DB.prepare('SELECT org_id FROM users WHERE email = ?')
    .bind(email)
    .first<{ org_id: string }>();
  if (existing) {
    // Deliberately the same message whether the address belongs to this
    // organization or another one — a 409 must not disclose other clients' users.
    throw conflict('That email address already has a login.');
  }

  const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM users WHERE org_id = ?')
    .bind(auth.org.id)
    .first<{ count: number }>();
  if ((count?.count ?? 0) >= MAX_MEMBERS_PER_ORG) {
    throw conflict(`An organization is limited to ${MAX_MEMBERS_PER_ORG} logins.`);
  }

  // For a password login the temporary password is returned once, in this
  // response, and never stored in readable form; the account cannot be used
  // until it is changed. A Google-only login stores an unusable hash instead,
  // which `verifyPassword` can never match, so there is no password to issue.
  const temporaryPassword = googleOnly ? null : randomToken(12);
  const passwordHash = temporaryPassword
    ? await hashPassword(temporaryPassword, pbkdf2Iterations(env))
    : UNUSABLE_PASSWORD_HASH;

  const now = Date.now();
  const id = newId('usr');

  await env.DB.prepare(
    `INSERT INTO users (
       id, org_id, email, name, role, phone,
       password_hash, must_change_password, disabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(
      id,
      auth.org.id,
      email,
      name,
      role,
      phone,
      passwordHash,
      temporaryPassword ? 1 : 0,
      now,
      now,
    )
    .run();

  await writeAudit(env.DB, {
    orgId: auth.org.id,
    userId: auth.user.id,
    action: 'users.create',
    target: id,
    detail: `${email} as ${role}, ${googleOnly ? 'Google sign-in only' : 'password login'}`,
    ip: clientIp(request),
  });

  const created = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(id)
    .first<UserRow>();
  if (!created) throw notFound('The login could not be created.');

  const payload: CreatedTeamMember = {
    member: toTeamMember(created, auth.user.id),
    temporaryPassword,
  };
  return json(payload, { status: 201 });
}

export async function handleUpdateTeamMember(
  request: Request,
  env: Env,
  auth: AuthContext,
  userId: string,
): Promise<Response> {
  requirePermission(auth.user.role, 'users:manage');

  // Scoped by org_id: a user id from another client reads as simply not there.
  const target = await env.DB.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?')
    .bind(userId, auth.org.id)
    .first<UserRow>();
  if (!target) throw notFound('That login could not be found.');

  const body = await readJson<{
    role?: unknown;
    disabled?: unknown;
    name?: unknown;
    phone?: unknown;
    resetPassword?: unknown;
  }>(request);

  // Password reset is the recovery path for a locked-out client: there is no
  // self-service reset, so an owner issues a fresh temporary password. Handled
  // before the other fields because it returns a secret and nothing else.
  if (body.resetPassword === true) {
    const temporaryPassword = randomToken(12);
    const resetAt = Date.now();

    await env.DB.batch([
      env.DB.prepare(
        'UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ? AND org_id = ?',
      ).bind(
        await hashPassword(temporaryPassword, pbkdf2Iterations(env)),
        resetAt,
        target.id,
        auth.org.id,
      ),
      // Anyone holding the old password loses their sessions with it.
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id),
    ]);

    await writeAudit(env.DB, {
      orgId: auth.org.id,
      userId: auth.user.id,
      action: 'users.reset_password',
      target: target.id,
      ip: clientIp(request),
    });

    const refreshed = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(target.id)
      .first<UserRow>();
    if (!refreshed) throw notFound('That login could not be found.');

    const payload: CreatedTeamMember = {
      member: toTeamMember(refreshed, auth.user.id),
      temporaryPassword,
    };
    return json(payload);
  }

  const role = body.role === undefined ? target.role : parseRole(body.role);
  const disabled =
    body.disabled === undefined ? target.disabled === 1 : body.disabled === true;
  const name =
    body.name === undefined
      ? target.name
      : typeof body.name === 'string' && body.name.trim()
        ? body.name.trim()
        : (() => {
            throw badRequest('Name cannot be empty.');
          })();
  const phone =
    body.phone === undefined
      ? target.phone
      : typeof body.phone === 'string' && body.phone.trim()
        ? body.phone.trim()
        : null;

  // Guard against an owner locking themselves — and possibly the whole
  // organization — out of the dashboard.
  if (target.id === auth.user.id) {
    if (disabled) throw badRequest('You cannot disable your own login.');
    if (role !== 'owner') throw badRequest('You cannot remove your own owner access.');
  }

  if (target.role === 'owner' && (role !== 'owner' || disabled)) {
    const owners = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM users WHERE org_id = ? AND role = 'owner' AND disabled = 0",
    )
      .bind(auth.org.id)
      .first<{ count: number }>();
    if ((owners?.count ?? 0) <= 1) {
      throw badRequest('This business must keep at least one active owner.');
    }
  }

  const now = Date.now();
  await env.DB.prepare(
    'UPDATE users SET role = ?, disabled = ?, name = ?, phone = ?, updated_at = ? WHERE id = ? AND org_id = ?',
  )
    .bind(role, disabled ? 1 : 0, name, phone, now, target.id, auth.org.id)
    .run();

  // Disabling must take effect immediately, not whenever the session happens to
  // expire, so every session for that login is revoked here.
  if (disabled && target.disabled !== 1) {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id).run();
  }

  await writeAudit(env.DB, {
    orgId: auth.org.id,
    userId: auth.user.id,
    action: disabled && target.disabled !== 1 ? 'users.disable' : 'users.update',
    target: target.id,
    detail: `role=${role} disabled=${disabled}`,
    ip: clientIp(request),
  });

  const updated = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(target.id)
    .first<UserRow>();
  if (!updated) throw notFound('That login could not be found.');

  return json(toTeamMember(updated, auth.user.id));
}
