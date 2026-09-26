import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  encryptionConfigured,
  generateEncryptionKey,
  MissingEncryptionKeyError,
} from '../worker/lib/secretbox';

const env = { TOTP_ENCRYPTION_KEY: generateEncryptionKey() };

describe('secret envelope', () => {
  it('round-trips a TOTP seed', async () => {
    const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(await decryptSecret(env, await encryptSecret(env, seed))).toBe(seed);
  });

  it('produces different ciphertext each time', async () => {
    // A fresh IV per encryption. Reusing one under the same key is the single
    // way to break GCM outright, so identical inputs must not collide.
    const a = await encryptSecret(env, 'same');
    const b = await encryptSecret(env, 'same');
    expect(a).not.toBe(b);
    expect(await decryptSecret(env, a)).toBe(await decryptSecret(env, b));
  });

  it('carries a version prefix', async () => {
    expect(await encryptSecret(env, 'x')).toMatch(/^v1\./);
  });

  it('refuses ciphertext that has been altered', async () => {
    // The point of GCM over raw AES: a flipped bit fails loudly rather than
    // decrypting to a different, still plausible, seed.
    const envelope = await encryptSecret(env, 'GEZDGNBVGY3TQOJQ');
    const [version, iv, ciphertext] = envelope.split('.') as [string, string, string];
    const tampered = `${version}.${iv}.${ciphertext.slice(0, -4)}AAAA`;
    await expect(decryptSecret(env, tampered)).rejects.toThrow();
  });

  it('refuses a secret encrypted under a different key', async () => {
    const envelope = await encryptSecret(env, 'GEZDGNBVGY3TQOJQ');
    const other = { TOTP_ENCRYPTION_KEY: generateEncryptionKey() };
    await expect(decryptSecret(other, envelope)).rejects.toThrow();
  });

  it('refuses an envelope from an unknown format version', async () => {
    const envelope = await encryptSecret(env, 'x');
    await expect(decryptSecret(env, envelope.replace(/^v1/, 'v2'))).rejects.toThrow(
      /format this build understands/,
    );
  });
});

describe('key handling', () => {
  it('fails closed when no key is configured', async () => {
    // Never a default or derived key: every deployment would share it, and a
    // system that looks encrypted but is not is worse than one that refuses.
    await expect(encryptSecret({}, 'x')).rejects.toThrow(MissingEncryptionKeyError);
    await expect(encryptSecret({ TOTP_ENCRYPTION_KEY: '   ' }, 'x')).rejects.toThrow(
      MissingEncryptionKeyError,
    );
  });

  it('rejects a key of the wrong length', async () => {
    await expect(encryptSecret({ TOTP_ENCRYPTION_KEY: btoa('too short') }, 'x')).rejects.toThrow(
      /32 bytes/,
    );
  });

  it('rejects a key that is not base64', async () => {
    await expect(encryptSecret({ TOTP_ENCRYPTION_KEY: 'not base64 !!' }, 'x')).rejects.toThrow(
      /base64/,
    );
  });

  it('reports whether the deployment can handle 2FA at all', () => {
    expect(encryptionConfigured(env)).toBe(true);
    expect(encryptionConfigured({})).toBe(false);
    expect(encryptionConfigured({ TOTP_ENCRYPTION_KEY: btoa('short') })).toBe(false);
    expect(encryptionConfigured({ TOTP_ENCRYPTION_KEY: 'not base64 !!' })).toBe(false);
  });

  it('generates 256-bit keys', () => {
    expect(atob(generateEncryptionKey()).length).toBe(32);
    expect(new Set(Array.from({ length: 20 }, generateEncryptionKey)).size).toBe(20);
  });
});
