// Envelope encryption for the few values that must be readable by the Worker
// but useless to anyone holding a copy of the database.
//
// A TOTP seed is not a password. A password hash leaks nothing directly — an
// attacker still has to break it. A TOTP seed in the clear *is* the second
// factor: whoever reads it can generate valid codes forever, silently. So the
// seed is encrypted with a key that lives in the Worker's secrets rather than
// in D1, and a database dump on its own does not defeat two-factor auth.
//
// AES-256-GCM, because it authenticates as well as encrypts: ciphertext that
// has been altered fails to decrypt rather than producing plausible garbage.

import { base64ToBytes, bytesToBase64 } from './crypto';

const IV_BYTES = 12; // 96 bits, the size GCM is specified for.
const KEY_BYTES = 32;
const FORMAT = 'v1';

export class MissingEncryptionKeyError extends Error {
  constructor() {
    super(
      'TOTP_ENCRYPTION_KEY is not set on this deployment, so two-factor secrets ' +
        'cannot be read or written.',
    );
    this.name = 'MissingEncryptionKeyError';
  }
}

/**
 * Imports the configured key.
 *
 * Deliberately throws rather than falling back to a derived or default key.
 * A default would mean every deployment shares it, and an environment that
 * quietly encrypts with a guessable key is worse than one that refuses to
 * encrypt at all — it looks protected and is not.
 */
async function importKey(env: { TOTP_ENCRYPTION_KEY?: string }): Promise<CryptoKey> {
  const raw = env.TOTP_ENCRYPTION_KEY?.trim();
  if (!raw) throw new MissingEncryptionKeyError();

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(raw);
  } catch {
    throw new Error('TOTP_ENCRYPTION_KEY is not valid base64.');
  }
  if (bytes.length !== KEY_BYTES) {
    throw new Error(
      `TOTP_ENCRYPTION_KEY must be ${KEY_BYTES} bytes of base64; got ${bytes.length}.`,
    );
  }

  return crypto.subtle.importKey('raw', bytes as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** Whether this deployment can handle 2FA secrets at all. */
export function encryptionConfigured(env: { TOTP_ENCRYPTION_KEY?: string }): boolean {
  const raw = env.TOTP_ENCRYPTION_KEY?.trim();
  if (!raw) return false;
  try {
    return base64ToBytes(raw).length === KEY_BYTES;
  } catch {
    return false;
  }
}

/**
 * Returns `v1.<iv>.<ciphertext>`, both base64.
 *
 * The version prefix is there so a future key rotation or algorithm change can
 * tell old records from new ones instead of guessing at the bytes.
 */
export async function encryptSecret(
  env: { TOTP_ENCRYPTION_KEY?: string },
  plaintext: string,
): Promise<string> {
  const key = await importKey(env);
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      new TextEncoder().encode(plaintext) as BufferSource,
    ),
  );

  return `${FORMAT}.${bytesToBase64(iv)}.${bytesToBase64(ciphertext)}`;
}

export async function decryptSecret(
  env: { TOTP_ENCRYPTION_KEY?: string },
  envelope: string,
): Promise<string> {
  const parts = envelope.split('.');
  if (parts.length !== 3 || parts[0] !== FORMAT) {
    throw new Error('Stored secret is not in a format this build understands.');
  }

  const key = await importKey(env);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(parts[1] as string) as BufferSource },
    key,
    base64ToBytes(parts[2] as string) as BufferSource,
  );

  return new TextDecoder().decode(plaintext);
}

/** Prints a key for `wrangler secret put TOTP_ENCRYPTION_KEY`. */
export function generateEncryptionKey(): string {
  const bytes = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}
