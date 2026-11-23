// Both ways between the website and OMG's own calendar (src/calendar.js): the
// feed her calendar app subscribes to, reading her calendar's busy times
// (dates, time zones, repeats, exceptions), the link checks, the sync job, and
// the booking checks that use those busy times. Runs on real SQLite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import * as K from '../src/calendar.js';
import { busyOn, externalBusy } from '../src/calendar-busy.js';
import { availability, create } from '../src/bookings.js';
import { UTC_OFFSET_MINUTES } from '../public/js/catalog.js';
import { addDays, monthOf, nowInZone } from '../public/js/slots.js';
import { freshDb } from './d1.js';

// Workers have crypto.subtle.timingSafeEqual; Node has the same thing elsewhere.
if (!crypto.subtle.timingSafeEqual) crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

const NOW = Date.UTC(2026, 10, 15, 10, 0); // Sunday 15 November 2026, 12:00 in South Africa
const cal = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...events.flat(), 'END:VCALENDAR'].join('\r\n') + '\r\n';
const ev = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const busy = (...events) => K.busyFromIcs(cal(...events), NOW);
const unfold = (text) => text.replace(/\r\n[ \t]/g, '');

// ---------------------------------------------------------------- the feed

test('feed text is escaped, and long lines fold at 75 octets without splitting a character', () => {
  assert.equal(K.icsText('a;b,c\\d\ne\r\nf\u0007'), 'a\\;b\\,c\\\\d\\ne\\nf');
  const long = `SUMMARY:${'Glam 💄 · Thandí '.repeat(12)}`;
  const folded = K.foldLine(long);
  for (const line of folded.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
  assert.equal(unfold(folded), long);
  assert.equal(K.foldLine('SHORT:x'), 'SHORT:x');
});

test('with no bookings yet, the feed is still a calendar an iPhone accepts (it has a component)', () => {
  const ics = K.buildIcs([], NOW);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n[\s\S]*\r\nBEGIN:VTIMEZONE\r\nTZID:Africa\/Johannesburg\r\nBEGIN:STANDARD\r\n[\s\S]*\r\nEND:VTIMEZONE\r\nEND:VCALENDAR\r\n$/);
  assert.equal((ics.match(/^BEGIN:VEVENT\r$/gm) || []).length, 0);
  assert.deepEqual(K.busyFromIcs(ics, NOW), {}, 'our own feed reads back as nothing busy');
});

test('the feed: bookings in UTC, whole days as dates, only safe text', () => {
  const ics = K.buildIcs([
    { id: 7, date: '2026-12-12', start: '09:00', end: '10:30', kind: 'booking', label: 'Thandi', name: 'Thandi\r\nBEGIN:VEVENT', phone: '0821234567', ref: 'OMG-ABCD', service_name: 'Full Glam; lashes, too' },
    { id: 8, date: '2026-12-24', start: '00:00', end: '24:00', kind: 'closed', label: 'Christmas' },
    { id: 9, date: '2026-12-13', start: '14:00', end: '15:00', kind: 'booking', label: 'Walk-in, Lerato' },
    { id: 10, date: 'nope', start: '09:00', end: '10:00', kind: 'booking' },
  ], NOW);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'every line ends in CRLF');
  const text = unfold(ics);
  assert.equal(text.match(/^BEGIN:VEVENT\r$/gm).length, 3, 'the bad date is left out; the name could not add an event');
  assert.match(text, /UID:omg-block-7@omg-oh-my-glam\r\nDTSTAMP:20261115T100000Z\r\nDTSTART:20261212T070000Z\r\nDTEND:20261212T083000Z\r\nSUMMARY:Full Glam\x5c; lashes\\, too · Thandi\\nBEGIN:VEVENT\r\n/);
  assert.match(text, /DESCRIPTION:Phone: 0821234567\\nRef: OMG-ABCD\\nBooked on the website/);
  assert.match(text, /DTSTART;VALUE=DATE:20261224\r\nDTEND;VALUE=DATE:20261225\r\nSUMMARY:Time off: Christmas\r\n/);
  assert.match(text, /SUMMARY:Walk-in\\, Lerato\r\nTRANSP:OPAQUE/);
  assert.match(text, /X-WR-CALNAME:OMG bookings/);
});

test('the feed answers only its own link, is rate limited, and notes that it was collected', async () => {
  const { db, env } = freshDb();
  const token = 'a1'.repeat(24);
  db.prepare("INSERT INTO settings (key, value) VALUES ('calendar_feed_token', ?)").run(token);
  const date = addDays(nowInZone(UTC_OFFSET_MINUTES).date, 3);
  db.prepare("INSERT INTO booking_requests (id, ref, name, phone, service, date, start, minutes, status, created_at) VALUES (1, 'OMG-AAAA', 'Thandi M', '0821234567', 'full-glam', ?, '09:00', 90, 'confirmed', 1)").run(date);
  db.prepare("INSERT INTO booking_requests (id, ref, name, phone, service, date, start, minutes, status, created_at) VALUES (2, 'OMG-BBBB', 'Pending P', '0821234568', 'full-glam', ?, '13:00', 90, 'pending', 1)").run(date);
  db.prepare("INSERT INTO blocks (date, start, end, kind, label, request_id, created_at) VALUES (?, '09:00', '10:30', 'booking', 'Thandi M', 1, 1)").run(date);
  const get = (path, method = 'GET', client = 'c1') => K.feed(new Request(`https://omg.example${path}`, { method }), env, path.slice(10, -4), client);

  const ok = await get(`/calendar/${token}.ics`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const body = unfold(await ok.text());
  assert.match(body, /SUMMARY:Full Glam · Thandi M/);
  assert.match(body, /Phone: 0821234567/);
  assert.ok(!body.includes('Pending P'), 'requests not yet confirmed stay out');
  assert.ok(Number(db.prepare("SELECT value FROM settings WHERE key = 'calendar_feed_seen'").get().value) > Date.now() - 5000);

  assert.equal((await get(`/calendar/${'b2'.repeat(24)}.ics`)).status, 404, 'another token');
  assert.equal((await get(`/calendar/${token.toUpperCase()}.ics`)).status, 404, 'not the stored form');
  assert.equal((await get("/calendar/' OR 1=1 --.ics")).status, 404);
  assert.equal((await get(`/calendar/${token}.ics`, 'POST')).status, 405);
  const head = await get(`/calendar/${token}.ics`, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  let last;
  for (let i = 0; i < 125; i += 1) last = await get(`/calendar/${'c3'.repeat(24)}.ics`, 'GET', 'guesser');
  assert.equal(last.status, 429, 'guessing runs into the limit');
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  assert.equal((await get(`/calendar/${token}.ics`, 'GET', 'c2')).status, 200, 'others are unaffected');
});

// ---------------------------------------------------------------- reading her calendar

test('her calendar link: iCloud, Google or Outlook only', () => {
  assert.equal(K.importUrl('webcal://p52-caldav.icloud.com/published/2/MTIzNDU2'), 'https://p52-caldav.icloud.com/published/2/MTIzNDU2');
  assert.equal(K.importUrl('  https://calendar.google.com/calendar/ical/a%40gmail.com/private-abc/basic.ics '), 'https://calendar.google.com/calendar/ical/a%40gmail.com/private-abc/basic.ics');
  assert.equal(K.importUrl('http://outlook.office365.com/owa/calendar/x/y/calendar.ics'), 'https://outlook.office365.com/owa/calendar/x/y/calendar.ics');
  for (const bad of [
    '', 'not a link', 'javascript:alert(1)', 'file:///etc/passwd', 'https://evil.example/calendar.ics',
    'https://p52-caldav.icloud.com.evil.example/x', 'https://calendar.google.com.evil.example/x', 'https://evil.example/calendar.google.com',
    'https://user:pw@calendar.google.com/x', 'https://calendar.google.com:8443/x', 'https://127.0.0.1/x', 'https://icloud.com/x',
    `https://calendar.google.com/${'x'.repeat(2100)}`, 42, null,
  ]) {
    assert.throws(() => K.importUrl(bad), (e) => e.status === 400 && e.extra.field === 'url', String(bad).slice(0, 50));
  }
});

test('downloading her calendar: redirects stay on allowed hosts; errors are plain', async () => {
  const ICS = cal(ev('UID:1', 'DTSTART:20261201T080000Z', 'DTEND:20261201T090000Z'));
  const hops = [];
  const fake = (routes) => async (url, init) => {
    hops.push(url);
    assert.equal(init.redirect, 'manual');
    const r = routes[url];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : new Response(r?.body ?? null, { status: r?.status ?? 404, headers: r?.headers ?? {} });
  };
  const A = 'https://p01-caldav.icloud.com/published/2/abc';
  const B = 'https://p52-caldav.icloud.com/published/2/abc';
  const got = await K.fetchCalendar(A, { fetchImpl: fake({ [A]: { status: 301, headers: { location: B } }, [B]: { status: 200, body: ICS, headers: { etag: '"v1"' } } }) });
  assert.equal(got.text, ICS);
  assert.match(got.hash, /^[a-f0-9]{64}$/);
  assert.equal(got.etag, '"v1"');
  assert.deepEqual(hops, [A, B]);

  const reason = async (routes) => K.fetchCalendar(A, { fetchImpl: fake(routes) }).then(() => 'ok', (e) => `${e.status} ${e.code}`);
  assert.equal(await reason({ [A]: { status: 302, headers: { location: 'https://evil.example/x' } } }), '422 calendar_unreachable');
  assert.equal(await reason({ [A]: { status: 302, headers: { location: A } } }), '422 calendar_unreachable', 'a redirect loop ends');
  assert.equal(await reason({ [A]: { status: 404 } }), '422 calendar_unreachable');
  assert.equal(await reason({ [A]: new Error('dns') }), '422 calendar_unreachable');
  assert.equal(await reason({ [A]: { status: 200, body: '<html>Sign in</html>' } }), '422 calendar_unreadable');
  const huge = () => new Response(new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('BEGIN:VCALENDAR\r\n'));
      for (let i = 0; i < 40; i += 1) c.enqueue(new Uint8Array(100_000).fill(65));
      c.close();
    },
  }), { status: 200 });
  assert.equal(await reason({ [A]: huge }), '422 calendar_too_large');
  const broken = () => new Response(new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('BEGIN:VCALENDAR\r\n'));
      c.error(new Error('connection reset'));
    },
  }), { status: 200 });
  assert.equal(await reason({ [A]: broken }), '422 calendar_unreachable', 'cut off part-way');
});

test('busy times: zones, whole days, durations, free and cancelled events', () => {
  assert.deepEqual(busy(
    ev('UID:a', 'DTSTART;TZID=Africa/Johannesburg:20261116T100000', 'DTEND;TZID=Africa/Johannesburg:20261116T113000', 'SUMMARY:Client'),
    ev('UID:b', 'DTSTART:20261117T060000Z', 'DURATION:PT45M'),
    ev('UID:c', 'DTSTART:20261118T140000', 'DTEND:20261118T150000'),
    ev('UID:d', 'DTSTART;VALUE=DATE:20261120', 'DTEND;VALUE=DATE:20261122'),
    ev('UID:e', 'DTSTART;VALUE=DATE:20261123', 'TRANSP:TRANSPARENT'),
    ev('UID:f', 'DTSTART:20261124T070000Z', 'DTEND:20261124T080000Z', 'STATUS:CANCELLED'),
    ev('UID:g', 'DTSTART;TZID=/Africa/Johannesburg:20261125T220000', 'DTEND;TZID=/Africa/Johannesburg:20261126T020000'),
    ev('UID:h', 'DTSTART;TZID="(UTC+02:00) Harare, Pretoria":20261127T100000', 'DTEND;TZID="(UTC+02:00) Harare, Pretoria":20261127T110000'),
    ev('UID:i', 'DTSTART;TZID=Europe/London:20270705T090000', 'DTEND;TZID=Europe/London:20270705T100000'),
    ev('UID:j', 'DTSTART;TZID=Europe/London:20261207T090000', 'DTEND;TZID=Europe/London:20261207T100000'),
    ev('UID:k', 'DTSTART:20250101T080000Z', 'DTEND:20250101T090000Z'),
    ev('UID:l', 'DTSTART;VALUE=DATE:20261128'),
  ), {
    '2026-11-16': [[600, 690]],
    '2026-11-17': [[480, 525]],
    '2026-11-18': [[840, 900]],
    '2026-11-20': [[0, 1440]],
    '2026-11-21': [[0, 1440]],
    '2026-11-25': [[1320, 1440]],
    '2026-11-26': [[0, 120]],
    '2026-11-27': [[600, 660]],
    '2026-11-28': [[0, 1440]],
    '2026-12-07': [[660, 720]],
    '2027-07-05': [[600, 660]],
  });
});

test('only the event lines are read: alarms, time-zone rules and other parts are skipped', () => {
  const text = cal(
    'BEGIN:VTIMEZONE', 'TZID:Europe/London', 'BEGIN:DAYLIGHT', 'DTSTART:19810329T010000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT', 'END:VTIMEZONE',
    'BEGIN:VTODO', 'DTSTART:20261201T080000Z', 'DUE:20261201T090000Z', 'END:VTODO',
    ev('UID:a', 'DTSTART:20261202T080000Z', 'DTEND:20261202T090000Z', 'BEGIN:VALARM', 'TRIGGER:-PT15M', 'DTSTART:20261203T080000Z', 'DURATION:PT1H', 'END:VALARM',
      'DESCRIPTION:a note that says\\nDTSTART:20261204T080000Z on a line of its own', 'LOCATION:12 Long St'),
  );
  assert.deepEqual(K.busyFromIcs(text, NOW), { '2026-12-02': [[600, 660]] });
  const lower = text.replace(/BEGIN:VEVENT/g, 'begin:vevent').replace(/END:VEVENT/g, 'end:vevent').replace(/DTSTART:/g, 'dtstart:').replace(/DTEND:/g, 'dtend:');
  assert.deepEqual(K.busyFromIcs(lower, NOW), { '2026-12-02': [[600, 660]] }, 'names in any case');
  const lf = text.replace(/\r\n/g, '\n');
  assert.deepEqual(K.busyFromIcs(lf, NOW), { '2026-12-02': [[600, 660]] }, 'bare LF line ends');
});

test('repeats: weekly with exceptions, and COUNT counted from the start', () => {
  assert.deepEqual(busy(ev('UID:w', 'DTSTART;TZID=Africa/Johannesburg:20261116T100000', 'DTEND;TZID=Africa/Johannesburg:20261116T113000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4', 'EXDATE;TZID=Africa/Johannesburg:20261118T100000')), {
    '2026-11-16': [[600, 690]], '2026-11-23': [[600, 690]], '2026-11-25': [[600, 690]],
  });
  // Weekly since 6 October 2025, 60 times: only the 59th and 60th are still ahead.
  const counted = busy(ev('UID:c', 'DTSTART:20251006T080000Z', 'DTEND:20251006T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=60'));
  assert.deepEqual(Object.keys(counted), ['2026-11-16', '2026-11-23']);
});

test('repeats from years ago still block today, and UNTIL ends them', () => {
  const daily = busy(ev('UID:d', 'DTSTART;TZID=Africa/Johannesburg:20190101T070000', 'DTEND;TZID=Africa/Johannesburg:20190101T080000', 'RRULE:FREQ=DAILY'));
  assert.equal(Object.keys(daily).length, 402, 'every day of the window');
  assert.deepEqual(daily['2026-11-14'], [[420, 480]]);
  assert.deepEqual(daily['2027-12-20'], [[420, 480]]);
  const until = busy(ev('UID:u', 'DTSTART;TZID=Africa/Johannesburg:20190101T070000', 'DTEND;TZID=Africa/Johannesburg:20190101T080000', 'RRULE:FREQ=DAILY;UNTIL=20261130T215959Z'));
  assert.equal(Object.keys(until).at(-1), '2026-11-30');
  // Every other Monday since 2020: the right Mondays, not just any.
  const fortnightly = busy(ev('UID:f', 'DTSTART:20200106T080000Z', 'DTEND:20200106T090000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'));
  const expected = [];
  for (let t = Date.UTC(2020, 0, 6); t < Date.UTC(2027, 11, 21); t += 14 * 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    if (date >= '2026-11-14') expected.push(date);
  }
  assert.deepEqual(Object.keys(fortnightly), expected);
});

test('repeats: monthly and yearly rules', () => {
  assert.deepEqual(Object.keys(busy(ev('UID:m', 'DTSTART:20260130T160000Z', 'DTEND:20260130T180000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR'))).slice(0, 3),
    ['2026-11-27', '2026-12-25', '2027-01-29'], 'last Friday of the month');
  assert.deepEqual(Object.keys(busy(ev('UID:m31', 'DTSTART:20260131T080000Z', 'DTEND:20260131T090000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=31'))),
    ['2026-12-31', '2027-01-31', '2027-03-31', '2027-05-31', '2027-07-31', '2027-08-31', '2027-10-31'], 'months without a 31st are skipped');
  assert.deepEqual(Object.keys(busy(ev('UID:y', 'DTSTART:20200308T080000Z', 'DTEND:20200308T090000Z', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU'))),
    ['2027-03-14'], 'second Sunday of March');
  assert.deepEqual(busy(ev('UID:leap', 'DTSTART:20160229T080000Z', 'DTEND:20160229T090000Z', 'RRULE:FREQ=YEARLY')), {}, '29 February only in leap years');
  assert.deepEqual(Object.keys(busy(ev('UID:bd', 'DTSTART;VALUE=DATE:20151201', 'DTEND;VALUE=DATE:20151202', 'RRULE:FREQ=YEARLY'))), ['2026-12-01', '2027-12-01']);
});

test('repeats: a moved or cancelled single instance, and folded exception lists', () => {
  assert.deepEqual(busy(
    ev('UID:s', 'DTSTART;TZID=Africa/Johannesburg:20261116T100000', 'DTEND;TZID=Africa/Johannesburg:20261116T110000', 'RRULE:FREQ=WEEKLY;COUNT=3'),
    ev('UID:s', 'RECURRENCE-ID;TZID=Africa/Johannesburg:20261123T100000', 'DTSTART;TZID=Africa/Johannesburg:20261124T150000', 'DTEND;TZID=Africa/Johannesburg:20261124T160000'),
    ev('UID:s', 'RECURRENCE-ID;TZID=Africa/Johannesburg:20261130T100000', 'DTSTART;TZID=Africa/Johannesburg:20261130T100000', 'DTEND;TZID=Africa/Johannesburg:20261130T110000', 'STATUS:CANCELLED'),
  ), { '2026-11-16': [[600, 660]], '2026-11-24': [[900, 960]] });
  assert.deepEqual(Object.keys(busy(ev('UID:x', 'DTSTART;VALUE=DATE:20261201', 'DTEND;VALUE=DATE:20261202', 'RRULE:FREQ=DAILY;COUNT=5', 'EXDATE;VALUE=DATE:20261202,', ' 20261204'))),
    ['2026-12-01', '2026-12-03', '2026-12-05']);
});

test('a huge COUNT or nonsense rule cannot run away', () => {
  const t = Date.now();
  const out = busy(ev('UID:n', 'DTSTART:19000101T080000Z', 'DTEND:19000101T090000Z', 'RRULE:FREQ=DAILY;COUNT=99999999'));
  assert.deepEqual(out, {}, 'the count is used up long before the window');
  assert.deepEqual(busy(ev('UID:z', 'DTSTART:20261201T080000Z', 'DTEND:20261201T090000Z', 'RRULE:FREQ=SECONDLY')), { '2026-12-01': [[600, 660]] });
  assert.deepEqual(busy(ev('UID:z2', 'DTSTART:20261201T080000Z', 'DTEND:20261201T070000Z')), {}, 'ends before it starts');
  assert.ok(Date.now() - t < 2000);
});

// ---------------------------------------------------------------- the sync job

test('the sync stores busy times, skips work when nothing changed, and keeps them when a read fails', async () => {
  const { db, env } = freshDb();
  assert.equal(await K.syncCalendar(env, { fetchImpl: async () => { throw new Error('not called'); }, now: NOW }), null, 'nothing linked');
  db.prepare("INSERT INTO settings (key, value) VALUES ('calendar_import_url', 'https://calendar.google.com/calendar/ical/x/private-y/basic.ics')").run();
  let text = cal(ev('UID:1', 'DTSTART:20261201T080000Z', 'DTEND:20261201T090000Z'));
  let fail = false;
  const fetchImpl = async () => (fail ? new Response('nope', { status: 500 }) : new Response(text, { status: 200 }));
  const stored = () => JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'calendar_busy'").get().value);

  const first = await K.syncCalendar(env, { fetchImpl, now: NOW });
  assert.equal(first.ok, true);
  assert.equal(first.times, 1);
  assert.deepEqual(stored(), { '2026-12-01': [[600, 660]] });
  assert.deepEqual(busyOn(await externalBusy(env), '2026-12-01'), [[600, 660]]);

  const same = await K.syncCalendar(env, { fetchImpl, now: NOW + 900_000 });
  assert.equal(same.computedAt, NOW, 'unchanged: not worked out again');
  assert.equal(same.checkedAt, NOW + 900_000);

  text = cal(ev('UID:1', 'DTSTART:20261202T080000Z', 'DTEND:20261202T100000Z'));
  const changed = await K.syncCalendar(env, { fetchImpl, now: NOW + 1_800_000 });
  assert.equal(changed.computedAt, NOW + 1_800_000);
  assert.deepEqual(stored(), { '2026-12-02': [[600, 720]] });

  fail = true;
  const failed = await K.syncCalendar(env, { fetchImpl, now: NOW + 2_700_000 });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /\(500\)/);
  assert.equal(failed.readAt, NOW + 1_800_000, 'when it was last read is kept');
  assert.deepEqual(stored(), { '2026-12-02': [[600, 720]] }, 'the last busy times stay');

  fail = false;
  const back = await K.syncCalendar(env, { fetchImpl, now: NOW + 3_600_000 });
  assert.equal(back.ok, true, 'reads again after a failure');
  assert.equal(back.error, undefined);
});

test('an unchanged calendar answering "not modified" is not downloaded again; a weekly read still happens', async () => {
  const { db, env } = freshDb();
  db.prepare("INSERT INTO settings (key, value) VALUES ('calendar_import_url', 'https://p01-caldav.icloud.com/published/2/abc')").run();
  const text = cal(ev('UID:1', 'DTSTART:20261201T080000Z', 'DTEND:20261201T090000Z'));
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(init.headers);
    if (init.headers['if-none-match'] === '"v7"') return new Response(null, { status: 304 });
    return new Response(text, { status: 200, headers: { etag: '"v7"', 'last-modified': 'Sun, 15 Nov 2026 09:00:00 GMT' } });
  };
  const first = await K.syncCalendar(env, { fetchImpl, now: NOW });
  assert.equal(first.etag, '"v7"');
  assert.equal(sent[0]['if-none-match'], undefined);
  const second = await K.syncCalendar(env, { fetchImpl, now: NOW + 900_000 });
  assert.equal(sent[1]['if-none-match'], '"v7"');
  assert.equal(sent[1]['if-modified-since'], 'Sun, 15 Nov 2026 09:00:00 GMT');
  assert.equal(second.computedAt, NOW, 'not worked out again');
  assert.equal(second.readAt, NOW + 900_000, 'but it counts as a good read');
  const weekLater = await K.syncCalendar(env, { fetchImpl, now: NOW + 8 * 86_400_000 });
  assert.equal(sent[2]['if-none-match'], undefined, 'a weekly read asks for the whole file');
  assert.equal(weekLater.computedAt, NOW + 8 * 86_400_000);
  const forced = await K.syncCalendar(env, { fetchImpl, now: NOW + 8 * 86_400_000 + 60_000, force: true });
  assert.equal(sent[3]['if-none-match'], undefined, '"Check now" reads the whole file');
  assert.equal(forced.computedAt, NOW + 8 * 86_400_000 + 60_000);
});

test('stored busy times are checked when read', async () => {
  const { db, env } = freshDb();
  assert.deepEqual(await externalBusy(env), {});
  db.prepare("INSERT INTO settings (key, value) VALUES ('calendar_busy', ?)").run(JSON.stringify({
    '2026-12-01': [[600, 660], [700, 650], ['x', 1], [-5, 20], [0, 1441], [100.5, 200]],
    '2026-12-02': 'nonsense',
  }));
  const stored = await externalBusy(env);
  assert.deepEqual(busyOn(stored, '2026-12-01'), [[600, 660]]);
  assert.deepEqual(busyOn(stored, '2026-12-02'), []);
  assert.deepEqual(busyOn(stored, '__proto__'), []);
  db.prepare("UPDATE settings SET value = '{broken' WHERE key = 'calendar_busy'").run();
  assert.deepEqual(await externalBusy(env), {});
});

// ---------------------------------------------------------------- what the website does with them

test("busy times in her calendar show as busy, and can't be booked", async () => {
  const { db, env } = freshDb();
  const today = nowInZone(UTC_OFFSET_MINUTES).date;
  const date = addDays(today, 10);
  db.prepare("INSERT INTO settings (key, value) VALUES ('calendar_busy', ?)").run(JSON.stringify({ [date]: [[630, 660]] }));
  db.prepare("INSERT INTO blocks (date, start, end, kind, label, request_id, created_at) VALUES (?, '10:00', '10:30', 'closed', NULL, NULL, 1)").run(date);

  const res = await availability({ env, url: new URL(`https://omg.example/api/availability?month=${monthOf(date)}`), client: 'c' });
  const data = await res.json();
  assert.deepEqual(data.busy[date], [['10:00', '11:00']], 'merged with time off, nothing personal');

  const book = (time) => create({
    env, client: 'c', waitUntil: () => {}, url: new URL('https://omg.example/api/bookings'),
    request: new Request('https://omg.example/api/bookings', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://omg.example' },
      body: JSON.stringify({ name: 'Thandi M', phone: '0821234567', service: 'full-glam', date, time, elapsed: 9000 }),
    }),
  }).then((r) => r.status, (e) => e.status);
  assert.equal(await book('09:30'), 409, 'runs into her own appointment');
  assert.equal(await book('11:00'), 201, 'right after it is free');
});

test('the admin calendar shows her busy times, and warns before booking over them', async () => {
  const { db, env } = freshDb();
  const { createBlock, listBlocks } = await import('../src/admin.js');
  const { sha256Hex } = await import('../src/ratelimit.js');
  const token = 'T'.repeat(43);
  db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').run(await sha256Hex(token), Date.now() + 60_000);
  const date = addDays(nowInZone(UTC_OFFSET_MINUTES).date, 5);
  db.prepare("INSERT INTO settings (key, value) VALUES ('calendar_busy', ?)").run(JSON.stringify({ [date]: [[600, 660], [900, 960]], '2099-01-01': [[0, 60]] }));
  const headers = { cookie: `__Host-omg_admin=${token}`, 'content-type': 'application/json', origin: 'https://omg.example' };
  const ctx = (method, path, body) => ({
    env, client: 'admin', params: [], url: new URL(`https://omg.example${path}`),
    request: new Request(`https://omg.example${path}`, { method, headers, body: body && JSON.stringify(body) }),
  });

  const listed = await (await listBlocks(ctx('GET', `/api/admin/blocks?from=${date}&to=${date}`))).json();
  assert.deepEqual(listed.external, { [date]: [['10:00', '11:00'], ['15:00', '16:00']] }, 'only dates in the range');

  const clash = await createBlock(ctx('POST', '/api/admin/blocks', { date, start: '10:30', end: '12:00', kind: 'booking', label: 'Walk-in' })).then(() => null, (e) => e);
  assert.equal(clash.status, 409);
  assert.deepEqual(clash.extra.conflicts, [{ id: null, start: '10:00', end: '11:00', kind: 'calendar', label: null }]);
  const forced = await createBlock(ctx('POST', '/api/admin/blocks', { date, start: '10:30', end: '12:00', kind: 'booking', label: 'Walk-in', force: true }));
  assert.equal(forced.status, 201, 'she can still add it on purpose');
  assert.equal((await createBlock(ctx('POST', '/api/admin/blocks', { date, start: '12:00', end: '13:00', kind: 'closed' }))).status, 201, 'free time is free');
});
