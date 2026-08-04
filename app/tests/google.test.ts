import { describe, expect, it } from 'vitest';
import { buildAuthorizeUrl, googleConfigured, parseIdToken, redirectUriFor } from '../worker/lib/google';
import type { Env } from '../worker/env';

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
    const token = idToken({ ...validClaims, aud: 'someone-else.apps.googleusercontent.com' });
    expect(() => parseIdToken(token, CLIENT_ID, NONCE)).toThrowError(/different application/);
  });

  it('accepts an aud array that contains our client', () => {
    const token = idToken({ ...validClaims, aud: ['other', CLIENT_ID] });
    expect(parseIdToken(token, CLIENT_ID, NONCE).sub).toBe('110000000000000000001');
  });

  it('rejects an unexpected issuer', () => {
    const token = idToken({ ...validClaims, iss: 'https://evil.example' });
    expect(() => parseIdToken(token, CLIENT_ID, NONCE)).toThrowError(/unexpected issuer/);
  });

  it('rejects a replayed token whose nonce does not match this sign-in', () => {
    const token = idToken({ ...validClaims, nonce: 'a-different-nonce' });
    expect(() => parseIdToken(token, CLIENT_ID, NONCE)).toThrowError(/expired/);
  });

  it('rejects an expired token', () => {
    const token = idToken({ ...validClaims, exp: Math.floor(Date.now() / 1000) - 3600 });
    expect(() => parseIdToken(token, CLIENT_ID, NONCE)).toThrowError(/expired/);
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
    expect(() => parseIdToken('not-a-jwt', CLIENT_ID, NONCE)).toThrowError(/Malformed/);
    expect(() => parseIdToken('a.b', CLIENT_ID, NONCE)).toThrowError(/Malformed/);
    expect(() => parseIdToken('a.!!!.c', CLIENT_ID, NONCE)).toThrowError(/Could not read/);
  });

  it('rejects a token with no subject or email', () => {
    const { sub: _sub, ...withoutSub } = validClaims;
    expect(() => parseIdToken(idToken(withoutSub), CLIENT_ID, NONCE)).toThrowError(/email address/);
  });
});
