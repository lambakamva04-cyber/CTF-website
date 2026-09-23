// Time-based one-time passwords, RFC 6238.
//
// Written out rather than pulled from npm: the algorithm is about sixty lines,
// and a dependency in the authentication path is a dependency that can be
// compromised. Everything here runs on the WebCrypto that Workers already has.
//
// The parameters are the ones every authenticator app assumes by default —
// SHA-1, 30-second step, 6 digits. SHA-1 is weak as a collision-resistant hash
// and irrelevantly so here: HMAC-SHA1 has no practical break, and choosing
// SHA-256 would mean codes that Google Authenticator silently computes wrong.

export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;

/**
 * How many steps either side of now are accepted. One step covers a phone whose
 * clock is up to 30 seconds out, and the code someone started typing just as
 * the window rolled over. Wider would triple the guess space for no real gain.
 */
export const TOTP_SKEW_STEPS = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, unpadded — the encoding every authenticator app expects. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];

  return out;
}

export function base32Decode(input: string): Uint8Array {
  // Padding and spacing are stripped: people paste secrets with both, and
  // rejecting a secret over a trailing '=' is a support ticket for nothing.
  const cleaned = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Not valid base32.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return new Uint8Array(out);
}

/** A fresh shared secret. 20 bytes is the RFC 4226 recommendation for SHA-1. */
export function generateSecret(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

/** The counter a timestamp falls in. Exported because replay defence needs it. */
export function counterAt(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  // The counter is eight bytes, big-endian. Written as two 32-bit halves
  // because a JS number cannot hold the full 64 bits exactly, and the high half
  // is zero until the year 10 000 anyway.
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);

  const key = await crypto.subtle.importKey(
    'raw',
    secret as BufferSource,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message as BufferSource));

  // Dynamic truncation, RFC 4226 section 5.3. The low nibble of the last byte
  // picks where to read four bytes from; the top bit is masked off so the
  // result is positive in languages without unsigned ints.
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number);

  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
}

/** The code for a given moment. Exported for tests and for the enrolment check. */
export function totpAt(secretBase32: string, atMs: number): Promise<string> {
  return hotp(base32Decode(secretBase32), counterAt(atMs));
}

export interface TotpVerification {
  valid: boolean;
  /**
   * True when the code was right but belongs to a step already spent.
   *
   * Worth distinguishing from a wrong code, because it happens for a good
   * reason and looks like a fault: confirming an enrolment spends the current
   * step, so somebody who enrols and immediately signs in is staring at a code
   * their app says is current and being told it is wrong. The answer is "wait
   * thirty seconds", which is only useful advice if we can tell the two apart.
   */
  reused: boolean;
  /**
   * The step the code belongs to. Persist it and refuse anything at or below it
   * next time: without that, a code shoulder-surfed or captured in transit is
   * replayable for the rest of its 30-second life, and with the skew window,
   * for longer.
   */
  counter: number;
}

/**
 * Checks a submitted code against the accepted window.
 *
 * `lastUsedCounter` is the step of the last code this account successfully used;
 * pass null for an account that has never verified one.
 */
export async function verifyTotp(
  secretBase32: string,
  submitted: string,
  options: { atMs?: number; lastUsedCounter?: number | null } = {},
): Promise<TotpVerification> {
  const atMs = options.atMs ?? Date.now();
  const lastUsed = options.lastUsedCounter ?? null;

  const code = submitted.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return { valid: false, reused: false, counter: -1 };

  const secret = base32Decode(secretBase32);
  const current = counterAt(atMs);

  let match = -1;
  let reused = false;
  for (let offset = -TOTP_SKEW_STEPS; offset <= TOTP_SKEW_STEPS; offset++) {
    const counter = current + offset;

    const expected = await hotp(secret, counter);
    // Compared digit by digit over the full length rather than with ===, so the
    // time taken does not depend on how many leading digits were right.
    let diff = 0;
    for (let i = 0; i < TOTP_DIGITS; i++) {
      diff |= (expected.charCodeAt(i) ?? 0) ^ (code.charCodeAt(i) ?? 0);
    }
    if (diff !== 0) continue;

    // Matched. Whether it counts depends on whether the step is already spent.
    if (lastUsed !== null && counter <= lastUsed) reused = true;
    else match = counter;
  }

  if (match !== -1) return { valid: true, reused: false, counter: match };
  return { valid: false, reused, counter: -1 };
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * The issuer appears both as a path prefix and as a parameter. That is
 * redundant and it is what the spec's own examples do — older apps read one,
 * newer apps read the other, and an app that shows the wrong account name is a
 * support problem out of all proportion to the duplication.
 */
export function otpauthUri(options: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = `${encodeURIComponent(options.issuer)}:${encodeURIComponent(options.account)}`;
  const params = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
