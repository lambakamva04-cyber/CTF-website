import { describe, expect, it } from 'vitest';
import {
  checkPassword,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RULES,
  passwordRejectionMessage,
} from '../shared/password';

const met = (password: string, id: string) =>
  checkPassword(password).rules.find((rule) => rule.id === id)?.met;

describe('the five requirements', () => {
  it('lists them in the order the checklist shows', () => {
    expect(PASSWORD_RULES.map((rule) => rule.id)).toEqual([
      'length',
      'lowercase',
      'uppercase',
      'number',
      'symbol',
    ]);
  });

  it('accepts a password that satisfies all of them', () => {
    const result = checkPassword('Abcdef1!');
    expect(result.acceptable).toBe(true);
    expect(result.rules.every((rule) => rule.met)).toBe(true);
    expect(result.firstFailure).toBeNull();
  });

  it('fails one rule at a time, and says which', () => {
    // Each of these is otherwise complete and missing exactly one thing.
    expect(met('Abcde1!', 'length')).toBe(true); // exactly 7
    expect(met('Abcd1!', 'length')).toBe(false); // 6
    expect(met('ABCDEF1!', 'lowercase')).toBe(false);
    expect(met('abcdef1!', 'uppercase')).toBe(false);
    expect(met('Abcdefg!', 'number')).toBe(false);
    expect(met('Abcdefg1', 'symbol')).toBe(false);
  });

  it('treats the minimum as inclusive', () => {
    // Off-by-one here is the difference between "at least 7" and "more than 7",
    // and the label promises the former.
    const exact = 'Abcde1!';
    expect([...exact].length).toBe(MIN_PASSWORD_LENGTH);
    expect(checkPassword(exact).acceptable).toBe(true);
  });

  it('counts an empty password as failing everything', () => {
    const result = checkPassword('');
    expect(result.acceptable).toBe(false);
    expect(result.rules.every((rule) => !rule.met)).toBe(true);
    expect(result.score).toBe(0);
  });
});

describe('what counts as a letter, a number and a symbol', () => {
  it('accepts accented letters as letters', () => {
    // A client typing Zoë or señora is typing perfectly good letters. Matching
    // only [a-z] would leave the rule grey with no explanation.
    expect(met('zoë1234!', 'lowercase')).toBe(true);
    expect(met('ZOË1234!', 'uppercase')).toBe(true);
    expect(met('Señora1!', 'lowercase')).toBe(true);
  });

  it('does not mistake an accented letter for a symbol', () => {
    expect(met('Señora1', 'symbol')).toBe(false);
  });

  it('accepts a space as a symbol', () => {
    // A spaced passphrase is a good password. Refusing it on a technicality
    // teaches people to pick worse ones.
    expect(met('Correct Horse 1', 'symbol')).toBe(true);
    expect(checkPassword('Correct Horse 1').acceptable).toBe(true);
  });

  it('accepts punctuation and currency as symbols', () => {
    for (const symbol of ['!', '@', '#', '$', '%', '-', '_', '.', 'R', '€']) {
      const password = `Abcdef1${symbol}`;
      const isLetter = /\p{L}/u.test(symbol);
      expect(met(password, 'symbol')).toBe(!isLetter);
    }
  });

  it('counts length by code point, not UTF-16 unit', () => {
    // An emoji is two UTF-16 units. Counting it as two characters would let a
    // four-emoji password satisfy a seven-character rule.
    const emoji = '👍👍👍👍';
    expect(emoji.length).toBe(8);
    expect(met(emoji, 'length')).toBe(false);
  });
});

describe('the strength meter', () => {
  it('scores nothing for an empty box', () => {
    expect(checkPassword('').score).toBe(0);
  });

  it('rises as the password gets longer past the minimum', () => {
    const short = checkPassword('Abcde1!').score; // 7, all rules met
    const medium = checkPassword('Abcdefghijk1!').score; // 13
    const long = checkPassword('Abcdefghijklmnopq1!').score; // 19
    expect(short).toBeLessThan(medium);
    expect(medium).toBeLessThan(long);
    expect(long).toBe(4);
  });

  it('never reports strong for something that fails a rule', () => {
    // The meter is advice; the checklist is the gate. They must not contradict
    // each other by calling an unacceptable password strong.
    const longButNoSymbol = checkPassword('Abcdefghijklmnopqrst1');
    expect(longButNoSymbol.acceptable).toBe(false);
    expect(longButNoSymbol.strength).not.toBe('strong');
  });

  it('still credits a long passphrase that misses a class', () => {
    // Scoring this below a seven-character scramble would push people towards
    // the scramble, which is the worse password.
    const passphrase = checkPassword('correct horse battery staple');
    const scramble = checkPassword('Abcde1!');
    expect(passphrase.acceptable).toBe(false);
    expect(passphrase.score).toBeGreaterThanOrEqual(scramble.score);
  });

  it('keeps the score inside the range the meter draws', () => {
    for (const password of ['', 'a', 'Abcde1!', 'A'.repeat(200) + 'b1!']) {
      const { score } = checkPassword(password);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(4);
    }
  });
});

describe('the message the server sends back', () => {
  it('says nothing when the password is fine', () => {
    expect(passwordRejectionMessage('Abcdef1!')).toBeNull();
  });

  it('names every missing requirement, not just the first', () => {
    // Being told one problem at a time is the slowest possible way to learn
    // five rules.
    const message = passwordRejectionMessage('abc');
    expect(message).toContain('at least 7 characters');
    expect(message).toContain('one capital letter');
    expect(message).toContain('one number');
    expect(message).toContain('one symbol');
  });

  it('agrees with the checklist for every case tested here', () => {
    // The whole reason the rules live in one module: a password the client
    // shows as complete must never be refused by the server.
    for (const password of [
      '',
      'a',
      'Abcde1!',
      'Abcdefgh',
      'Correct Horse 1',
      'señora1!X',
      '👍👍👍👍👍👍👍A1!',
    ]) {
      const { acceptable } = checkPassword(password);
      expect(passwordRejectionMessage(password) === null).toBe(acceptable);
    }
  });
});
