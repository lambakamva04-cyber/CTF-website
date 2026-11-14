// Field checks for bookings, reviews and admin notes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../src/validate.js';
import { HttpError } from '../src/http.js';

const rejects = (fn, field) => {
  assert.throws(fn, (e) => e instanceof HttpError && e.status === 400 && e.extra.field === field);
};

test('text is normalised and hidden characters removed', () => {
  assert.equal(V.clean('  Thandi ​  Mokoena‮ '), 'Thandi Mokoena');
  assert.equal(V.clean('é'), 'é'); // NFC
  assert.equal(V.clean('a\u0000b\u0007c'), 'abc');
  assert.equal(V.clean(42), '');
  assert.equal(V.clean('line one\r\n\r\n\r\n\r\nline  two', { multiline: true }), 'line one\n\nline two');
});

test('booking names need a name and a surname, in letters', () => {
  assert.equal(V.personName(' Thandi   Mokoena '), 'Thandi Mokoena');
  for (const ok of ["Mary-Jane van der Merwe", "O'Neil Smith", 'J. Smith', 'Zoë Ndlovu', 'Ṣadé Adu', 'Ли Мин']) assert.ok(V.personName(ok), ok);
  for (const bad of ['Thandi', 'T', '', null, 123, ['Thandi Mokoena'], "Thandi' OR 1=1 --", '<script>x</script> y', 'Robert); DROP TABLE x;', 'a'.repeat(81) + ' b']) rejects(() => V.personName(bad), 'name');
});

test('phone numbers are 9 to 15 digits', () => {
  assert.equal(V.phoneNumber('082 123 4567'), '082 123 4567');
  assert.equal(V.phoneNumber('+27 (82) 123-4567'), '+27 (82) 123-4567');
  for (const bad of ['12345678', '1'.repeat(16), '082 123 4567 ext 2', "082' OR '1'='1", '+', '27+82123456', null]) rejects(() => V.phoneNumber(bad), 'phone');
});

test('services, dates and times come from fixed sets', () => {
  assert.equal(V.serviceId('soft-glam'), 'soft-glam');
  for (const bad of ['SOFT-GLAM', 'soft-glam ', "soft-glam' --", '__proto__', 'constructor', null]) rejects(() => V.serviceId(bad), 'service');
  rejects(() => V.dateValue('2026-02-30'), 'date');
  rejects(() => V.startTime('24:00'), 'time');
  rejects(() => V.startTime('09:30 '), 'time');
  assert.equal(V.blockTime('24:00', 'end'), '24:00');
  rejects(() => V.blockTime('09:03', 'start'), 'start');
});

test('ratings are the integers 1 to 4, nothing else', () => {
  for (const ok of [1, 2, 3, 4]) assert.equal(V.rating(ok), ok);
  for (const bad of [0, 5, 3.5, '4', true, null, NaN, Infinity, -1, [4]]) rejects(() => V.rating(bad), 'rating');
});

test('review names and comments', () => {
  assert.equal(V.reviewName('Lerato M.'), 'Lerato M.');
  for (const bad of ['L', 'a'.repeat(41), '<b>Lerato</b>', 'Lerato123']) rejects(() => V.reviewName(bad), 'name');
  assert.equal(V.reviewComment('  Beautiful   work, thank you!  '), 'Beautiful work, thank you!');
  for (const bad of ['Too short', 'x'.repeat(501), 'Great! see https://spam.example', 'Visit www.spam.example now please', 'Visit HTTP://SPAM.EXAMPLE now']) rejects(() => V.reviewComment(bad), 'comment');
  // 500 characters counted as characters, not UTF-16 units
  assert.equal(V.charCount(V.reviewComment('💄'.repeat(500))), 500);
});

test('admin notes are optional and short', () => {
  assert.equal(V.label(undefined), null);
  assert.equal(V.label('   '), null);
  assert.equal(V.label(' Wedding prep '), 'Wedding prep');
  rejects(() => V.label('x'.repeat(81)), 'label');
});

test('bot detection: honeypot and speed', () => {
  assert.ok(!V.looksAutomated({ company: '', elapsed: 15000 }));
  assert.ok(!V.looksAutomated({ elapsed: 2000 }));
  assert.ok(V.looksAutomated({ company: 'Acme', elapsed: 15000 }));
  assert.ok(V.looksAutomated({ company: '', elapsed: 500 }));
  assert.ok(V.looksAutomated({ company: '' }));
  assert.ok(V.looksAutomated({ elapsed: '15000' }));
});
