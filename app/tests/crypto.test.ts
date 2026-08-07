import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  needsRehash,
  randomToken,
  sha256Hex,
  timingSafeEqual,
  verifyPassword,
} from '../worker/lib/crypto';

// PBKDF2 at production strength is deliberately slow; the tests use a low work
// factor except where the default itself is under test.
const FAST = 1000;

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('Correct horse battery staple', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('salts each hash so identical passwords do not collide', async () => {
    const [a, b] = await Promise.all([hashPassword('same', FAST), hashPassword('same', FAST)]);
    expect(a).not.toEqual(b);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });

  it('encodes the work factor so hashes stay verifiable after it changes', async () => {
    const hash = await hashPassword('rotate me', FAST);
    expect(hash.startsWith(`pbkdf2$sha256$${FAST}$`)).toBe(true);
    expect(needsRehash(hash, 210_000)).toBe(true);
    expect(needsRehash(hash, FAST)).toBe(false);
  });

  it('rejects malformed or truncated stored hashes instead of throwing', async () => {
    for (const bad of ['', 'not-a-hash', 'pbkdf2$sha256$1000$only-three', 'bcrypt$x$y$z$w']) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('never matches the unusable hash given to Google-only logins', async () => {
    // '!' is stored for logins that sign in with Google and have no password.
    // Nothing a caller can submit may ever verify against it.
    for (const attempt of ['', '!', 'password', 'pbkdf2', '!!']) {
      expect(await verifyPassword(attempt, '!')).toBe(false);
    }
  });

  it('refuses an absurd iteration count that would hang the worker', async () => {
    const hostile = 'pbkdf2$sha256$999999999$AAAAAAAAAAAAAAAAAAAAAA==$AAAA';
    expect(await verifyPassword('anything', hostile)).toBe(false);
  });
});

describe('token and digest helpers', () => {
  it('produces unique url-safe session tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken(32)));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashes deterministically so a token maps to one session row', async () => {
    expect(await sha256Hex('abc')).toEqual(await sha256Hex('abc'));
    expect(await sha256Hex('abc')).not.toEqual(await sha256Hex('abd'));
  });

  it('compares secrets without short-circuiting on length', async () => {
    expect(await timingSafeEqual('secret', 'secret')).toBe(true);
    expect(await timingSafeEqual('secret', 'secrets')).toBe(false);
    expect(await timingSafeEqual('', '')).toBe(true);
  });
});
