import { describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  googleClientDiagnostics,
  googleConfigured,
  GoogleAuthError,
  parseIdToken,
  redirectUriFor,
  type GoogleFailureReason,
} from '../worker/lib/google';
import type { Env } from '../worker/env';

/** Asserts the thrown failure carries the reason the UI keys its message off. */
function expectReason(run: () => unknown, reason: GoogleFailureReason): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(GoogleAuthError);
    expect((error as GoogleAuthError).reason).toBe(reason);
    return;
  }
  expect.unreachable(`expected a ${reason} failure`);
}

const CLIENT_ID = '1234.apps.googleusercontent.com';
const NONCE = 'nonce-value';

function idToken(claims: Record<string, unknown>): string {
  // btoa rather than Buffer: these tests typecheck against the Workers runtime
  // types, where Node globals do not exist.
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // The signature is never checked — the token only ever arrives over TLS
  // straight from Google's token endpoint — so a placeholder is fine here.
  return `${encode({ alg: 'RS256' })}.${encode(claims)}.signature-not-verified`;
}

const validClaims = {
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: '110000000000000000001',
  email: 'Owner@Example.com',
  email_verified: true,
  name: 'Naledi Dube',
  nonce: NONCE,
  exp: Math.floor(Date.now() / 1000) + 3600,
};

describe('configuration', () => {
  it('is only enabled when both halves of the client are present', () => {
    expect(googleConfigured({} as Env)).toBe(false);
    expect(googleConfigured({ GOOGLE_CLIENT_ID: 'x' } as Env)).toBe(false);
    expect(googleConfigured({ GOOGLE_CLIENT_SECRET: 'y' } as Env)).toBe(false);
    expect(googleConfigured({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' } as Env)).toBe(true);
  });

  it('derives the callback from the request origin so both hostnames work', () => {
    expect(redirectUriFor(new URL('https://app.cutthroughfaster.com/api/auth/google/start'))).toBe(
      'https://app.cutthroughfaster.com/api/auth/google/callback',
    );
    expect(redirectUriFor(new URL('https://ctf-app.workers.dev/anything'))).toBe(
      'https://ctf-app.workers.dev/api/auth/google/callback',
    );
  });

  it('sends state and nonce to Google and asks for no offline access', () => {
    const url = new URL(
      buildAuthorizeUrl(
        { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 's' } as Env,
        { state: 'st', nonce: 'no', redirectUri: 'https://app.example/cb' },
      ),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('nonce')).toBe('no');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('access_type')).toBe('online');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
  });
});

describe('id token claims', () => {
  it('extracts a normalised identity', () => {
    const identity = parseIdToken(idToken(validClaims), CLIENT_ID, NONCE);
    expect(identity.sub).toBe('110000000000000000001');
    expect(identity.email).toBe('owner@example.com'); // lowercased for matching
    expect(identity.emailVerified).toBe(true);
    expect(identity.name).toBe('Naledi Dube');
  });

  it('rejects a token minted for a different application', () => {
    expectReason(
      () => parseIdToken(idToken({ ...validClaims, aud: 'other.apps.googleusercontent.com' }), CLIENT_ID, NONCE),
      'audience',
    );
  });

  it('accepts an aud array that contains our client', () => {
    const token = idToken({ ...validClaims, aud: ['other', CLIENT_ID] });
    expect(parseIdToken(token, CLIENT_ID, NONCE).sub).toBe('110000000000000000001');
  });

  it('rejects an unexpected issuer', () => {
    expectReason(
      () => parseIdToken(idToken({ ...validClaims, iss: 'https://evil.example' }), CLIENT_ID, NONCE),
      'issuer',
    );
  });

  it('rejects a replayed token whose nonce does not match this sign-in', () => {
    expectReason(
      () => parseIdToken(idToken({ ...validClaims, nonce: 'other-nonce' }), CLIENT_ID, NONCE),
      'nonce',
    );
  });

  it('rejects an expired token', () => {
    expectReason(
      () =>
        parseIdToken(
          idToken({ ...validClaims, exp: Math.floor(Date.now() / 1000) - 3600 }),
          CLIENT_ID,
          NONCE,
        ),
      'expired',
    );
  });

  it('distinguishes every failure, so the cause survives the redirect', () => {
    // Each reason maps to its own message on the sign-in screen; collapsing two
    // of them would put us back to guessing which step actually broke.
    const reasons = new Set<string>();
    const cases: (() => unknown)[] = [
      () => parseIdToken('not-a-jwt', CLIENT_ID, NONCE),
      () => parseIdToken(idToken({ ...validClaims, iss: 'https://evil.example' }), CLIENT_ID, NONCE),
      () => parseIdToken(idToken({ ...validClaims, aud: 'other' }), CLIENT_ID, NONCE),
      () => parseIdToken(idToken({ ...validClaims, nonce: 'x' }), CLIENT_ID, NONCE),
      () => parseIdToken(idToken({ ...validClaims, exp: 1 }), CLIENT_ID, NONCE),
    ];

    for (const run of cases) {
      try {
        run();
      } catch (error) {
        reasons.add((error as GoogleAuthError).reason);
      }
    }
    expect(reasons.size).toBe(cases.length);
  });

  it('reports an unverified email so the caller can refuse it', () => {
    const token = idToken({ ...validClaims, email_verified: false });
    expect(parseIdToken(token, CLIENT_ID, NONCE).emailVerified).toBe(false);
  });

  it('treats a missing email_verified claim as unverified', () => {
    const { email_verified: _omitted, ...withoutFlag } = validClaims;
    expect(parseIdToken(idToken(withoutFlag), CLIENT_ID, NONCE).emailVerified).toBe(false);
  });

  it('rejects structurally invalid tokens', () => {
    expectReason(() => parseIdToken('not-a-jwt', CLIENT_ID, NONCE), 'token_malformed');
    expectReason(() => parseIdToken('a.b', CLIENT_ID, NONCE), 'token_malformed');
    expectReason(() => parseIdToken('a.!!!.c', CLIENT_ID, NONCE), 'token_malformed');
  });

  it('rejects a token with no subject or email', () => {
    const { sub: _sub, ...withoutSub } = validClaims;
    expectReason(() => parseIdToken(idToken(withoutSub), CLIENT_ID, NONCE), 'missing_email');
  });
});

describe('client diagnostics', () => {
  it('reports a well-formed client id', () => {
    const diagnostics = googleClientDiagnostics({
      GOOGLE_CLIENT_ID: CLIENT_ID,
      GOOGLE_CLIENT_SECRET: 'secret',
    } as Env);
    expect(diagnostics).toEqual({
      clientId: CLIENT_ID,
      clientIdLooksValid: true,
      secretPresent: true,
    });
  });

  it('flags a client id that is not a Google client id', () => {
    expect(
      googleClientDiagnostics({ GOOGLE_CLIENT_ID: 'oops', GOOGLE_CLIENT_SECRET: 's' } as Env)
        .clientIdLooksValid,
    ).toBe(false);
  });

  it('trims whitespace, which a pasted secret often carries', () => {
    // `wrangler secret put` reads stdin; a trailing newline here would produce
    // an `aud` mismatch that looks like a generic failure.
    const env = {
      GOOGLE_CLIENT_ID: `  ${CLIENT_ID}\n`,
      GOOGLE_CLIENT_SECRET: ' secret \n',
    } as Env;
    expect(googleClientDiagnostics(env).clientId).toBe(CLIENT_ID);
    expect(googleClientDiagnostics(env).clientIdLooksValid).toBe(true);
    expect(googleConfigured(env)).toBe(true);
  });

  it('does not report a whitespace-only secret as present', () => {
    expect(
      googleClientDiagnostics({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: '   ' } as Env)
        .secretPresent,
    ).toBe(false);
  });
});
