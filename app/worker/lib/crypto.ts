// Password hashing, session tokens and constant-time comparisons.
//
// PBKDF2-HMAC-SHA256 is used because it is the only memory-hard-ish KDF
// available in the Workers WebCrypto implementation — bcrypt/argon2 would need
// a WASM dependency. Stored format is self-describing so the work factor can be
// raised later and old hashes still verify (and get upgraded on next login).

const DEFAULT_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Short opaque id for database rows. Not a secret. */
export function newId(prefix: string): string {
  return `${prefix}_${randomToken(12)}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compares two strings without leaking their contents through timing. Both
 * sides are hashed first so that even length differences are not observable.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** Produces `pbkdf2$sha256$<iterations>$<saltB64>$<hashB64>`. */
export async function hashPassword(password: string, iterations = DEFAULT_ITERATIONS): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const derived = await pbkdf2(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${bytesToBase64(salt)}$${bytesToBase64(derived)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 5) return false;
  const [scheme, hash, iterationsRaw, saltB64, expectedB64] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (scheme !== 'pbkdf2' || hash !== 'sha256') return false;

  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 5_000_000) return false;

  let salt: Uint8Array;
  try {
    salt = base64ToBytes(saltB64);
  } catch {
    return false;
  }

  const derived = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(bytesToBase64(derived), expectedB64);
}

/** True when a stored hash was produced with a weaker work factor than current. */
export function needsRehash(stored: string, iterations = DEFAULT_ITERATIONS): boolean {
  const parts = stored.split('$');
  if (parts.length !== 5) return true;
  return Number.parseInt(parts[2] as string, 10) < iterations;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export { DEFAULT_ITERATIONS };
