import type { Env } from '../env';
import { createSession, sessionCookie } from '../lib/auth';
import { randomToken } from '../lib/crypto';
import { writeAudit, type OrgRow, type UserRow } from '../lib/db';
import { clientIp, notFound } from '../lib/http';
import {
  buildAuthorizeUrl,
  exchangeCodeForIdentity,
  GoogleAuthError,
  googleClientDiagnostics,
  googleConfigured,
  redirectUriFor,
} from '../lib/google';

/** A sign-in must be completed within this window or the state expires. */
const STATE_TTL_MS = 10 * 60 * 1000;

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 302,
    headers: { location, 'cache-control': 'no-store', ...headers },
  });
}

/**
 * Sends the browser to Google. The state and nonce are stored server-side in
 * D1 rather than in a cookie, which makes them single-use: the callback deletes
 * the row as it redeems it, so a replayed callback URL finds nothing.
 */
export async function handleGoogleStart(request: Request, env: Env): Promise<Response> {
  if (!googleConfigured(env)) {
    throw notFound('Google sign-in is not configured for this deployment.');
  }

  const url = new URL(request.url);
  const state = randomToken(32);
  const nonce = randomToken(32);
  const now = Date.now();

  await env.DB.prepare(
    'INSERT INTO oauth_states (state, nonce, redirect_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(state, nonce, null, now, now + STATE_TTL_MS)
    .run();

  // Opportunistic cleanup; these rows are tiny but there is no reason to keep
  // abandoned sign-ins around.
  await env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(now).run();

  return redirect(
    buildAuthorizeUrl(env, { state, nonce, redirectUri: redirectUriFor(url) }),
  );
}

/**
 * Google redirects back here. Failures send the browser to the sign-in screen
 * with a short reason code rather than rendering an error page, so the user
 * lands somewhere they can actually retry from.
 */
export async function handleGoogleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (!googleConfigured(env)) return redirect('/?auth_error=google_unavailable');

  const googleError = url.searchParams.get('error');
  if (googleError) {
    // The user pressed Cancel on Google's consent screen, most likely.
    return redirect(
      `/?auth_error=${googleError === 'access_denied' ? 'google_cancelled' : 'google_failed'}`,
    );
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return redirect('/?auth_error=google_failed');

  // Redeem the state: a single DELETE...RETURNING makes it impossible for two
  // concurrent callbacks to both succeed with the same state.
  const stateRow = await env.DB.prepare(
    'DELETE FROM oauth_states WHERE state = ? RETURNING nonce, expires_at',
  )
    .bind(state)
    .first<{ nonce: string; expires_at: number }>();

  if (!stateRow) return redirect('/?auth_error=google_expired');
  if (stateRow.expires_at < Date.now()) return redirect('/?auth_error=google_expired');

  let identity;
  try {
    identity = await exchangeCodeForIdentity(
      env,
      code,
      redirectUriFor(url),
      stateRow.nonce,
    );
  } catch (error) {
    // Logged in full for `wrangler tail`, including Google's own error code;
    // the browser only receives the coarse reason, which is enough to know
    // which step failed without disclosing anything about the configuration.
    if (error instanceof GoogleAuthError) {
      console.error('google_signin_failed', {
        reason: error.reason,
        message: error.message,
        detail: error.detail,
      });
      return redirect(`/?auth_error=google_${error.reason}`);
    }
    console.error('google_signin_failed_unexpected', error);
    return redirect('/?auth_error=google_failed');
  }

  if (!identity.emailVerified) return redirect('/?auth_error=google_unverified');

  // Match an already-provisioned login. Google sign-in is a way to authenticate
  // as an existing user, never a way to become one — the dashboard exposes live
  // calls and caller phone numbers, so account creation stays deliberate.
  const user = await env.DB.prepare(
    'SELECT * FROM users WHERE google_sub = ?1 OR (google_sub IS NULL AND email = ?2)',
  )
    .bind(identity.sub, identity.email)
    .first<UserRow>();

  if (!user) return redirect('/?auth_error=google_no_account');
  if (user.disabled === 1) return redirect('/?auth_error=account_disabled');

  const org = await env.DB.prepare('SELECT * FROM organizations WHERE id = ?')
    .bind(user.org_id)
    .first<OrgRow>();
  if (!org) return redirect('/?auth_error=no_org');

  const now = Date.now();

  // Bind the Google account on first use so later sign-ins match on `sub`, which
  // survives the user changing their email address at Google.
  if (!user.google_sub) {
    await env.DB.prepare(
      'UPDATE users SET google_sub = ?, google_linked_at = ?, updated_at = ? WHERE id = ?',
    )
      .bind(identity.sub, now, now, user.id)
      .run();
  }

  // A login still flagged for password rotation would otherwise be sent to the
  // change-password screen, which asks for the temporary password it was given.
  // Having just proved identity through Google, that detour is pointless — and
  // on a CPU-constrained plan the password check there may not even complete.
  // The temporary password stays valid until changed; an owner can reset it.
  if (user.must_change_password === 1) {
    await env.DB.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?')
      .bind(user.id)
      .run();
  }

  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .bind(now, user.id)
    .run();

  const { token, maxAgeSeconds } = await createSession(env, request, user.id);

  await writeAudit(env.DB, {
    orgId: org.id,
    userId: user.id,
    action: 'auth.login.google',
    detail: identity.email,
    ip: clientIp(request),
  });

  return redirect('/', { 'set-cookie': sessionCookie(token, maxAgeSeconds) });
}

/**
 * Lets the sign-in screen show the Google button only when it will work, and
 * reports the exact callback this deployment will send to Google.
 *
 * The callback is derived from the request origin, so it differs between the
 * custom domain and the workers.dev URL — and Google rejects the whole sign-in
 * with `redirect_uri_mismatch` if the one it receives is not registered
 * verbatim. Publishing it here turns that into a copy-and-paste rather than a
 * guess. It is a public URL and discloses nothing.
 */
export function googleAvailability(env: Env, requestUrl: URL): {
  google: boolean;
  redirectUri: string;
  clientId: string | null;
  clientIdLooksValid: boolean;
  secretPresent: boolean;
} {
  return {
    google: googleConfigured(env),
    redirectUri: redirectUriFor(requestUrl),
    ...googleClientDiagnostics(env),
  };
}
