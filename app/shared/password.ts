// Password rules, in one place so the checklist a client watches tick green and
// the check the server actually enforces cannot disagree.
//
// That single source is the whole point of this file. Duplicating the rules —
// a regex in a component, an `if` in a route — is how you get a form that goes
// all green and then fails on submit, which reads as a broken product rather
// than a rejected password.

/**
 * Minimum length.
 *
 * Set to 7 as specified. Worth knowing what that trades away: length buys more
 * than composition does, and the four character-class rules below do not make
 * up the difference. "Passw0rd!" satisfies every rule here and is on the first
 * page of every cracking dictionary. Raising this one number is the single
 * highest-value change available if the appetite is there.
 */
export const MIN_PASSWORD_LENGTH = 7;

/** Beyond this, length alone is doing the work and the meter says so. */
export const STRONG_PASSWORD_LENGTH = 16;

export type PasswordRuleId = 'length' | 'lowercase' | 'uppercase' | 'number' | 'symbol';

export interface PasswordRule {
  id: PasswordRuleId;
  /** Shown in the checklist, so it reads as a requirement, not an error. */
  label: string;
  test: (password: string) => boolean;
}

/**
 * Unicode-aware rather than `[a-z]`. A South African client with a name or word
 * carrying an accent — Zoë, Müller, señora — would otherwise type a perfectly
 * good lowercase letter and watch the rule stay grey with no explanation.
 */
export const PASSWORD_RULES: readonly PasswordRule[] = [
  {
    id: 'length',
    label: `At least ${MIN_PASSWORD_LENGTH} characters`,
    // Counted by code point, so an emoji or an accented letter counts once
    // rather than as the two UTF-16 units it happens to occupy.
    test: (password) => [...password].length >= MIN_PASSWORD_LENGTH,
  },
  {
    id: 'lowercase',
    label: 'One lowercase letter',
    test: (password) => /\p{Ll}/u.test(password),
  },
  {
    id: 'uppercase',
    label: 'One capital letter',
    test: (password) => /\p{Lu}/u.test(password),
  },
  {
    id: 'number',
    label: 'One number',
    test: (password) => /\p{Nd}/u.test(password),
  },
  {
    id: 'symbol',
    label: 'One symbol',
    // Anything that is not a letter, a number or a mark. Spaces count, which is
    // deliberate: a spaced passphrase is a good password and refusing it on a
    // technicality teaches people to pick worse ones.
    test: (password) => /[^\p{L}\p{N}\p{M}]/u.test(password),
  },
];

export interface PasswordRuleResult {
  id: PasswordRuleId;
  label: string;
  met: boolean;
}

export type PasswordStrength = 'weak' | 'fair' | 'good' | 'strong';

export interface PasswordCheck {
  rules: PasswordRuleResult[];
  /** Every rule satisfied — the only thing the server gates on. */
  acceptable: boolean;
  /** 0–4, for the meter. Advisory: a low score never blocks submission. */
  score: number;
  strength: PasswordStrength;
  /** The first unmet rule, phrased for an error message. */
  firstFailure: string | null;
}

export function checkPassword(password: string): PasswordCheck {
  const rules = PASSWORD_RULES.map((rule) => ({
    id: rule.id,
    label: rule.label,
    met: rule.test(password),
  }));

  const acceptable = rules.every((rule) => rule.met);
  const length = [...password].length;

  // The meter is about how much better than the minimum this is, not whether it
  // passes — the checklist already answers that. Length dominates because it
  // genuinely dominates: every extra character multiplies the search space,
  // while a fourth character class merely widens the alphabet once.
  let score = 0;
  if (password.length > 0) {
    score = 1;
    if (acceptable) score = 2;
    if (acceptable && length >= 12) score = 3;
    if (acceptable && length >= STRONG_PASSWORD_LENGTH) score = 4;
    // A long passphrase that happens to miss a class is still worth more than
    // a seven-character scramble, and saying otherwise pushes people towards
    // the scramble.
    if (!acceptable && length >= STRONG_PASSWORD_LENGTH) score = 2;
  }

  const strength: PasswordStrength =
    score >= 4 ? 'strong' : score === 3 ? 'good' : score === 2 ? 'fair' : 'weak';

  return {
    rules,
    acceptable,
    score,
    strength,
    firstFailure: rules.find((rule) => !rule.met)?.label ?? null,
  };
}

/** The server's message when a password is refused. */
export function passwordRejectionMessage(password: string): string | null {
  const { acceptable, rules } = checkPassword(password);
  if (acceptable) return null;

  const missing = rules.filter((rule) => !rule.met).map((rule) => rule.label.toLowerCase());
  return `That password needs: ${missing.join(', ')}.`;
}
