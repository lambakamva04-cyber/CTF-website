import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  counterAt,
  generateSecret,
  otpauthUri,
  TOTP_STEP_SECONDS,
  totpAt,
  verifyTotp,
} from '../worker/lib/totp';

/** The RFC 6238 appendix B seed: the ASCII digits "12345678901234567890". */
const RFC_SECRET_BYTES = new TextEncoder().encode('12345678901234567890');
const RFC_SECRET = base32Encode(RFC_SECRET_BYTES);

describe('base32', () => {
  it('matches the known encoding of the RFC seed', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('round-trips arbitrary bytes', () => {
    for (const length of [1, 2, 3, 4, 5, 10, 20, 32]) {
      const bytes = new Uint8Array(length).map((_, index) => (index * 37 + 11) % 256);
      expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes]);
    }
  });

  it('tolerates the padding and spacing people paste', () => {
    // Authenticator apps display secrets in groups of four; users paste them
    // that way, and rejecting that is a support ticket for nothing.
    expect([...base32Decode('GEZDGNBV GY3TQOJQ')]).toEqual([...base32Decode('GEZDGNBVGY3TQOJQ')]);
    expect([...base32Decode('GEZDGNBVGY3TQOJQ====')]).toEqual([
      ...base32Decode('GEZDGNBVGY3TQOJQ'),
    ]);
  });

  it('rejects characters outside the alphabet', () => {
    // 0, 1 and 8 are excluded from base32 precisely because they are confusable
    // with O, I and B. Silently accepting them would produce a secret that
    // enrols but never verifies.
    expect(() => base32Decode('GEZDGNBV0')).toThrow();
    expect(() => base32Decode('nonsense!')).toThrow();
  });
});

describe('TOTP against the RFC 6238 test vectors', () => {
  // Appendix B publishes eight-digit codes; six-digit is the low six, because
  // the truncation is a modulo. Any deviation here means the HMAC, the counter
  // packing or the dynamic truncation is wrong.
  const vectors: [seconds: number, code: string][] = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];

  for (const [seconds, expected] of vectors) {
    it(`T=${seconds} produces ${expected}`, async () => {
      expect(await totpAt(RFC_SECRET, seconds * 1000)).toBe(expected);
    });
  }

  it('packs counters above the 32-bit boundary correctly', async () => {
    // None of the published vectors reach here — the counter is seconds÷30, so
    // even T=20000000000 is only ~6.7e8. An implementation that writes the
    // counter as a single 32-bit word passes every RFC vector and then silently
    // wraps, so it is worth a test of its own.
    const low = 5;
    const high = 2 ** 32 + low;
    const msFor = (counter: number) => counter * TOTP_STEP_SECONDS * 1000;

    expect(counterAt(msFor(high))).toBe(high);
    // A 32-bit-only implementation would give these two the same code.
    expect(await totpAt(RFC_SECRET, msFor(high))).not.toBe(
      await totpAt(RFC_SECRET, msFor(low)),
    );
  });
});

describe('verification window', () => {
  const now = 1_700_000_000_000;

  it('accepts the current code', async () => {
    const code = await totpAt(RFC_SECRET, now);
    expect(await verifyTotp(RFC_SECRET, code, { atMs: now })).toEqual({
      valid: true,
      reused: false,
      counter: counterAt(now),
    });
  });

  it('accepts one step either side, for a phone with a drifting clock', async () => {
    for (const offset of [-30_000, 30_000]) {
      const code = await totpAt(RFC_SECRET, now + offset);
      const result = await verifyTotp(RFC_SECRET, code, { atMs: now });
      expect(result.valid).toBe(true);
      expect(result.counter).toBe(counterAt(now + offset));
    }
  });

  it('rejects two steps out', async () => {
    for (const offset of [-90_000, 90_000]) {
      const code = await totpAt(RFC_SECRET, now + offset);
      expect((await verifyTotp(RFC_SECRET, code, { atMs: now })).valid).toBe(false);
    }
  });

  it('refuses a code that has already been used', async () => {
    // Without this a code captured in transit stays good for the rest of its
    // window — and with the skew allowance, past it.
    const code = await totpAt(RFC_SECRET, now);
    const first = await verifyTotp(RFC_SECRET, code, { atMs: now });
    expect(first.valid).toBe(true);

    const replay = await verifyTotp(RFC_SECRET, code, {
      atMs: now,
      lastUsedCounter: first.counter,
    });
    expect(replay.valid).toBe(false);
  });

  it('tells a spent code apart from a wrong one', async () => {
    // Confirming an enrolment spends the current step, so somebody who enrols
    // and immediately signs in is looking at a code their app calls current and
    // being told it is wrong. The advice is "wait thirty seconds", which is only
    // sayable if the two cases are distinguishable.
    const code = await totpAt(RFC_SECRET, now);
    const spent = await verifyTotp(RFC_SECRET, code, {
      atMs: now,
      lastUsedCounter: counterAt(now),
    });
    expect(spent).toEqual({ valid: false, reused: true, counter: -1 });

    const wrong = await verifyTotp(RFC_SECRET, '000000', {
      atMs: now,
      lastUsedCounter: counterAt(now),
    });
    expect(wrong.reused).toBe(false);
  });

  it('refuses an older code once a newer one has been used', async () => {
    // Someone who used the current code must not be able to fall back to the
    // previous step, which the skew window would otherwise still accept.
    const previous = await totpAt(RFC_SECRET, now - 30_000);
    const result = await verifyTotp(RFC_SECRET, previous, {
      atMs: now,
      lastUsedCounter: counterAt(now),
    });
    expect(result.valid).toBe(false);
  });

  it('rejects anything that is not six digits', async () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56 78', '<script>']) {
      expect((await verifyTotp(RFC_SECRET, bad, { atMs: now })).valid).toBe(false);
    }
  });

  it('ignores spaces inside an otherwise valid code', async () => {
    const code = await totpAt(RFC_SECRET, now);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect((await verifyTotp(RFC_SECRET, spaced, { atMs: now })).valid).toBe(true);
  });

  it('rejects a code from a different secret', async () => {
    const other = generateSecret();
    const code = await totpAt(other, now);
    expect((await verifyTotp(RFC_SECRET, code, { atMs: now })).valid).toBe(false);
  });
});

describe('generated secrets', () => {
  it('are 160 bits, the RFC 4226 recommendation for SHA-1', () => {
    expect(base32Decode(generateSecret()).length).toBe(20);
  });

  it('differ every time', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateSecret()));
    expect(secrets.size).toBe(50);
  });
});

describe('otpauth URI', () => {
  const uri = otpauthUri({
    secret: RFC_SECRET,
    account: 'thandi@riverside.co.za',
    issuer: 'Cut Through Faster',
  });

  it('carries the parameters an authenticator app reads', () => {
    const parsed = new URL(uri);
    expect(parsed.protocol).toBe('otpauth:');
    expect(parsed.searchParams.get('secret')).toBe(RFC_SECRET);
    expect(parsed.searchParams.get('issuer')).toBe('Cut Through Faster');
    expect(parsed.searchParams.get('algorithm')).toBe('SHA1');
    expect(parsed.searchParams.get('digits')).toBe('6');
    expect(parsed.searchParams.get('period')).toBe('30');
  });

  it('escapes the issuer and account in the label', () => {
    // The issuer has a space in it, and the account is an email address. An
    // unescaped label is what makes an app show a mangled account name.
    expect(uri).toContain('Cut%20Through%20Faster:thandi%40riverside.co.za');
  });
});
