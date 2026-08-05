// Google Sign-In via the OpenID Connect authorization-code flow.
//
// Everything here runs server-side with the client secret; no token ever
// reaches the browser. The browser only carries an opaque `state` through the
// redirect, and that state is single-use and stored in D1.

import type { Env } from '../env';

/**
 * Why a Google sign-in failed, at a granularity that survives the redirect back
 * to the sign-in screen. Without this every failure collapses into "did not
 * complete", which is untriageable from the browser — and the Worker's logs are
 * not something a client can read.
 */
export type GoogleFailureReason =
  /** Google refused the code-for-token exchange. Usually a bad client secret. */
  | 'token_exchange'
  /** The response was not a readable JWT. */
  | 'token_malformed'
  /** `iss` was not Google. */
  | 'issuer'
  /** `aud` did not match our client id — very often a stray space in the secret. */
  | 'audience'
  /** `nonce` did not match the sign-in we started. */
  | 'nonce'
  /** The identity token had already expired. */
  | 'expired'
  /** Google returned no subject or email address. */
  | 'missing_email';

export class GoogleAuthError extends Error {
  constructor(
    readonly reason: GoogleFailureReason,
    message: string,
    /** Safe to log; never sent to the browser. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const VALID_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const TOKEN_TIMEOUT_MS = 10_000;
/** Tolerance for clock skew between us and Google when checking `exp`. */
const CLOCK_SKEW_MS = 60_000;

export interface GoogleIdentity {
  /** Google's stable user id. Survives the user changing their email address. */
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

/**
 * Credentials are trimmed on read. `wrangler secret put` takes the value from
 * stdin, and a pasted client id that picks up a trailing newline produces an
 * `aud` mismatch that is invisible in the console and reads as a generic
 * failure — worth defending against once here rather than debugging twice.
 */
export function clientId(env: Env): string {
  return (env.GOOGLE_CLIENT_ID ?? '').trim();
}

export function clientSecret(env: Env): string {
  return (env.GOOGLE_CLIENT_SECRET ?? '').trim();
}

export function googleConfigured(env: Env): boolean {
  return Boolean(clientId(env) && clientSecret(env));
}

/**
 * Non-secret signals for diagnosing a misconfigured client. The client id is
 * public — it travels in the authorize URL the browser follows — so echoing it
 * back discloses nothing, and it is the fastest way to spot a value that was
 * pasted with whitespace or truncated.
 */
export function googleClientDiagnostics(env: Env): {
  clientId: string | null;
  clientIdLooksValid: boolean;
  secretPresent: boolean;
  secretLooksValid: boolean;
  /** True when the raw value had surrounding whitespace, which we trim away. */
  secretHadWhitespace: boolean;
} {
  const id = clientId(env);
  const rawSecret = env.GOOGLE_CLIENT_SECRET ?? '';
  const secret = rawSecret.trim();

  return {
    clientId: id || null,
    clientIdLooksValid: id.endsWith('.apps.googleusercontent.com'),
    secretPresent: secret.length > 0,
    // A hint, not a verdict: the console has issued `GOCSPX-` prefixed secrets
    // for years, so a value without it is usually a client id pasted into the
    // wrong box — the single most common cause of `invalid_client`. Older
    // secrets predate the prefix, hence "looks".
    secretLooksValid: secret.startsWith('GOCSPX-'),
    secretHadWhitespace: rawSecret !== secret,
  };
}

/** The callback must match a redirect URI registered in the Google console. */
export function redirectUriFor(requestUrl: URL): string {
  return `${requestUrl.origin}/api/auth/google/callback`;
}

export function buildAuthorizeUrl(
  env: Env,
  options: { state: string; nonce: string; redirectUri: string },
): string {
  const params = new URLSearchParams({
    client_id: clientId(env),
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: options.state,
    nonce: options.nonce,
    // We only ever match an existing account, so there is nothing to gain from
    // offline access or a refresh token.
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

interface TokenResponse {
  id_token?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeCodeForIdentity(
  env: Env,
  code: string,
  redirectUri: string,
  expectedNonce: string,
): Promise<GoogleIdentity> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);

  let payload: TokenResponse;
  try {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId(env),
        client_secret: clientSecret(env),
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: controller.signal,
    });
    payload = (await response.json().catch(() => ({}))) as TokenResponse;

    if (!response.ok) {
      // `error` and `error_description` are Google's own diagnosis — by far the
      // most useful thing in the whole flow, so both are carried into the log.
      throw new GoogleAuthError(
        'token_exchange',
        `Google rejected the token exchange (${response.status}).`,
        `${payload.error ?? 'unknown'}: ${payload.error_description ?? 'no description'}`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new GoogleAuthError('token_exchange', 'Google did not respond in time.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!payload.id_token) {
    throw new GoogleAuthError('token_exchange', 'Google returned no identity token.');
  }

  return parseIdToken(payload.id_token, clientId(env), expectedNonce);
}

function decodeSegment(segment: string): unknown {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Reads the claims out of an ID token and validates them.
 *
 * The signature is deliberately not re-verified. This token was not supplied by
 * the browser — it was fetched by this Worker directly from Google's token
 * endpoint over TLS, authenticated with our client secret, which is exactly the
 * case where Google's own documentation says signature verification can be
 * skipped. The claims below are still checked, because TLS proves *who sent it*
 * and not *what it says*.
 *
 * If this function is ever changed to accept a token from anywhere else — a
 * request body, a query parameter, a client-side flow — signature verification
 * against Google's JWKS becomes mandatory.
 */
export function parseIdToken(
  idToken: string,
  expectedAudience: string,
  expectedNonce: string,
): GoogleIdentity {
  const segments = idToken.split('.');
  if (segments.length !== 3) {
    throw new GoogleAuthError('token_malformed', 'Malformed identity token from Google.');
  }

  let claims: Record<string, unknown>;
  try {
    claims = decodeSegment(segments[1] as string) as Record<string, unknown>;
  } catch {
    throw new GoogleAuthError('token_malformed', 'Could not read the identity token.');
  }

  const issuer = typeof claims.iss === 'string' ? claims.iss : '';
  if (!VALID_ISSUERS.has(issuer)) {
    throw new GoogleAuthError('issuer', 'Identity token has an unexpected issuer.', issuer);
  }

  // `aud` pins the token to our OAuth client, so a token minted for a different
  // application cannot be presented here.
  const audience = claims.aud;
  const audienceOk = Array.isArray(audience)
    ? audience.includes(expectedAudience)
    : audience === expectedAudience;
  if (!audienceOk) {
    throw new GoogleAuthError(
      'audience',
      'Identity token was issued for a different application.',
      `expected ${expectedAudience}, got ${String(audience)}`,
    );
  }

  // `nonce` ties the token to the specific sign-in we started, defeating replay.
  if (claims.nonce !== expectedNonce) {
    throw new GoogleAuthError('nonce', 'Identity token does not match this sign-in.');
  }

  const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : 0;
  if (exp + CLOCK_SKEW_MS < Date.now()) {
    throw new GoogleAuthError('expired', 'Identity token had already expired.');
  }

  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!sub || !email) {
    throw new GoogleAuthError('missing_email', 'Google returned no subject or email address.');
  }

  return {
    sub,
    email,
    // An unverified address proves nothing about who controls the mailbox, so
    // it must never be used to match a provisioned login.
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : null,
  };
}
