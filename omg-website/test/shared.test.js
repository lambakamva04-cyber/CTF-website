// The modules shared by the page and the Worker: time and date maths, and the
// booking catalogue and WhatsApp message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../public/js/slots.js';
import * as C from '../public/js/catalog.js';

test('times parse strictly', () => {
  assert.equal(S.toMinutes('09:30'), 570);
  assert.equal(S.toMinutes('24:00'), 1440);
  for (const bad of ['24:30', '9:30', '09:3', '0930', '', null, 570, "09:30' OR '1'='1"]) assert.ok(Number.isNaN(S.toMinutes(bad)), String(bad));
  assert.equal(S.toHHMM(570), '09:30');
});

test('dates are real calendar dates', () => {
  assert.ok(S.isDate('2028-02-29'));
  for (const bad of ['2027-02-29', '2026-13-01', '2026-00-10', '2026-1-1', '2026-01-01T00:00', "2026-01-01' OR 1=1", 20260101]) assert.ok(!S.isDate(bad), String(bad));
  assert.ok(S.isMonth('2026-12') && !S.isMonth('2026-13') && !S.isMonth('2026-1'));
});

test('date arithmetic crosses months and years', () => {
  assert.equal(S.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(S.daysBetween('2026-11-14', '2026-12-14'), 30);
  assert.equal(S.weekday('2026-11-14'), 5); // a Saturday
  assert.equal(S.addMonths('2026-12', 1), '2027-01');
  assert.equal(S.addMonths('2027-01', -1), '2026-12');
  assert.equal(S.daysInMonth('2028-02'), 29);
  assert.equal(S.datesInMonth('2026-02').length, 28);
});

test('SAST "now" and minimum notice cross midnight correctly', () => {
  const now = S.nowInZone(120, Date.UTC(2026, 10, 14, 22, 30)); // 00:30 SAST on the 15th
  assert.deepEqual(now, { date: '2026-11-15', minutes: 30 });
  assert.equal(S.notBeforeFor('2026-11-15', now, 180), 210);
  assert.equal(S.notBeforeFor('2026-11-16', now, 180), 0);
  const late = { date: '2026-11-15', minutes: 1400 };
  assert.ok(S.notBeforeFor('2026-11-15', late, 180) > 1440);
  assert.equal(S.notBeforeFor('2026-11-16', late, 180), 140);
});

test('busy ranges merge, and junk is dropped', () => {
  const busy = S.parseRanges([['13:00', '18:00'], ['09:00', '10:30'], ['10:30', '11:00'], ['x', 'y'], ['12:00', '11:00'], 'nope']);
  assert.deepEqual(busy, [[540, 660], [780, 1080]]);
  assert.deepEqual(S.formatRanges(busy), [['09:00', '11:00'], ['13:00', '18:00']]);
});

test('start times respect bookings, hours, the grid and notice', () => {
  const busy = S.parseRanges([['09:00', '11:00'], ['13:00', '18:00']]);
  const opts = { busy, minutes: 90, open: 360, close: 1080, step: 30 };
  const free = S.startTimes({ ...opts, notBefore: 400 }).filter((s) => s.free).map((s) => S.toHHMM(s.start));
  assert.deepEqual(free, ['07:00', '07:30', '11:00', '11:30']); // a slot may end exactly when the next begins
  assert.ok(S.isBookable({ ...opts, start: 690 }));
  assert.ok(!S.isBookable({ ...opts, start: 720 })); // runs into 13:00
  assert.ok(!S.isBookable({ ...opts, start: 675 })); // off the grid
  assert.ok(!S.isBookable({ ...opts, start: 330 })); // before opening
  assert.ok(!S.isBookable({ ...opts, start: 1020 })); // would end after closing
  assert.ok(!S.isBookable({ ...opts, start: 420, notBefore: 450 })); // too soon
});

test('every price-list card belongs to a booking group', () => {
  for (const [card, group] of Object.entries(C.GROUP_OF_CARD)) assert.ok(C.SERVICE_GROUPS.includes(group), card);
  assert.deepEqual(Object.keys(C.GROUP_OF_CARD).sort(), ['bride', 'bridesmaid', 'hair', 'makeup', 'package']);
  assert.equal(C.formatDuration(90), '1 h 30 min');
  assert.equal(C.formatDuration(120), '2 h');
});

test('the WhatsApp message carries the four details, labelled as OMG asked', () => {
  const fullGlam = { id: 'full-glam', name: 'Full Glam', price: 850, minutes: 90 };
  const msg = C.bookingMessage({ name: 'Thandi Mokoena', phone: '082 123 4567', service: fullGlam, date: '2026-12-12', time: '09:00', ref: 'OMG-7K2P' });
  assert.match(msg, /^Name and Surname: Thandi Mokoena$/m);
  assert.match(msg, /^Contact Number: 082 123 4567$/m);
  assert.match(msg, /^Service: Full Glam \(R850\)$/m);
  assert.match(msg, /^Date and Time: Saturday 12 December 2026 at 09:00$/m);
  assert.match(msg, /^Ref: OMG-7K2P$/m);
  assert.ok(!C.bookingMessage({ name: 'A B', phone: '1', service: fullGlam, date: '2026-12-12', time: '09:00' }).includes('Ref:'));
  const url = new URL(C.whatsappUrl(msg));
  assert.equal(url.origin + url.pathname, 'https://wa.me/27785767604');
  assert.equal(url.searchParams.get('text'), msg);
  assert.equal(new URL(C.whatsappUrl(msg, '27821234567')).pathname, '/27821234567', 'the number set on the admin page');
});
