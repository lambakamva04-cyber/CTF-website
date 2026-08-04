// Google Sign-In via the OpenID Connect authorization-code flow.
//
// Everything here runs server-side with the client secret; no token ever
// reaches the browser. The browser only carries an opaque `state` through the
// redirect, and that state is single-use and stored in D1.

import type { Env } from '../env';
import { badRequest, upstreamError } from './http';

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

export function googleConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
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
    client_id: env.GOOGLE_CLIENT_ID as string,
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
        client_id: env.GOOGLE_CLIENT_ID as string,
        client_secret: env.GOOGLE_CLIENT_SECRET as string,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: controller.signal,
    });
    payload = (await response.json().catch(() => ({}))) as TokenResponse;

    if (!response.ok) {
      throw upstreamError(
        `Google rejected the sign-in (${response.status}${
          payload.error ? `: ${payload.error}` : ''
        }).`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw upstreamError('Google did not respond in time.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!payload.id_token) throw upstreamError('Google did not return an identity token.');

  return parseIdToken(payload.id_token, env.GOOGLE_CLIENT_ID as string, expectedNonce);
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
  if (segments.length !== 3) throw upstreamError('Malformed identity token from Google.');

  let claims: Record<string, unknown>;
  try {
    claims = decodeSegment(segments[1] as string) as Record<string, unknown>;
  } catch {
    throw upstreamError('Could not read the identity token from Google.');
  }

  const issuer = typeof claims.iss === 'string' ? claims.iss : '';
  if (!VALID_ISSUERS.has(issuer)) throw upstreamError('Identity token has an unexpected issuer.');

  // `aud` pins the token to our OAuth client, so a token minted for a different
  // application cannot be presented here.
  const audience = claims.aud;
  const audienceOk = Array.isArray(audience)
    ? audience.includes(expectedAudience)
    : audience === expectedAudience;
  if (!audienceOk) throw upstreamError('Identity token was issued for a different application.');

  // `nonce` ties the token to the specific sign-in we started, defeating replay.
  if (claims.nonce !== expectedNonce) throw badRequest('This sign-in has expired. Please try again.');

  const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : 0;
  if (exp + CLOCK_SKEW_MS < Date.now()) throw badRequest('This sign-in has expired. Please try again.');

  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!sub || !email) throw upstreamError('Google did not return an email address.');

  return {
    sub,
    email,
    // An unverified address proves nothing about who controls the mailbox, so
    // it must never be used to match a provisioned login.
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : null,
  };
}
