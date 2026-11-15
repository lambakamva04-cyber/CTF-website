// The public calendar: what is busy in a month, and booking requests.

import {
  BOOKING_WINDOW, HOURS, UTC_OFFSET_MINUTES,
  bookingMessage, formatDateLong, serviceLabel, whatsappUrl,
} from '../public/js/catalog.js';
import {
  addDays, addMonths, formatRanges, isDate, isMonth, mergeRanges, monthOf, notBeforeFor, nowInZone,
  overlaps, parseRanges, toHHMM, toMinutes,
} from '../public/js/slots.js';
import { busyOn, externalBusy } from './calendar-busy.js';
import { bookableService, sitePhone } from './content.js';
import { HttpError, invalid, json, readJson } from './http.js';
import { alertInBackground } from './push.js';
import { enforce } from './ratelimit.js';
import { dateValue, looksAutomated, personName, phoneNumber, serviceId, startTime } from './validate.js';

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** "OMG-" and four characters nobody can misread (no 0/O, 1/I/L). */
export function newRef() {
  let out = '';
  while (out.length < 4) {
    for (const byte of crypto.getRandomValues(new Uint8Array(8))) {
      // 248 = 31 × 8: discarding bytes above it keeps every character equally likely.
      if (byte < 248 && out.length < 4) out += REF_ALPHABET[byte % REF_ALPHABET.length];
    }
  }
  return `OMG-${out}`;
}

/**
 * GET /api/availability?month=YYYY-MM: busy time ranges only, nothing
 * personal. Busy means booked or time off here, or busy in OMG's own calendar.
 */
export async function availability({ env, url, client }) {
  await enforce(env, 'read', client);
  const month = url.searchParams.get('month');
  const now = nowInZone(UTC_OFFSET_MINUTES);
  const first = monthOf(now.date);
  if (!isMonth(month) || month < first || month > addMonths(first, 12)) {
    throw invalid('month', 'Pick a month from now to a year ahead.');
  }
  const [{ results }, external] = await Promise.all([
    env.DB.prepare('SELECT date, start, end FROM blocks WHERE date >= ?1 AND date <= ?2').bind(`${month}-01`, `${month}-31`).all(),
    externalBusy(env),
  ]);
  const byDate = new Map();
  const add = (date, ranges) => {
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(...ranges);
  };
  for (const row of results) add(row.date, parseRanges([[row.start, row.end]]));
  for (const date of Object.keys(external)) if (date.startsWith(`${month}-`) && isDate(date)) add(date, busyOn(external, date));
  const busy = {};
  for (const date of [...byDate.keys()].sort()) {
    const ranges = formatRanges(byDate.get(date));
    if (ranges.length) busy[date] = ranges;
  }
  return json({ ok: true, month, today: now.date, now: toHHMM(now.minutes), busy });
}

function created(input, service, ref, phone) {
  return json(
    {
      ok: true,
      ref,
      whatsappUrl: whatsappUrl(bookingMessage({ ...input, service, ref }), phone),
      summary: {
        name: input.name,
        phone: input.phone,
        service: serviceLabel(service),
        when: `${formatDateLong(input.date)} at ${input.time}`,
      },
    },
    201,
  );
}

/** POST /api/bookings: stores a pending request and returns the WhatsApp link. */
export async function create(ctx) {
  const { env, request, client } = ctx;
  await enforce(env, 'bookingTry', client);
  const body = await readJson(request);
  const input = {
    name: personName(body.name),
    phone: phoneNumber(body.phone),
    service: serviceId(body.service),
    date: dateValue(body.date),
    time: startTime(body.time),
  };
  const service = await bookableService(env, input.service);
  if (!service) throw invalid('service', 'Please pick a service.');
  const phone = await sitePhone(env);

  const now = nowInZone(UTC_OFFSET_MINUTES);
  if (input.date < now.date || input.date > addDays(now.date, BOOKING_WINDOW.maxDaysAhead)) {
    throw invalid('date', 'Please pick a date from today to a year ahead.');
  }
  const start = toMinutes(input.time);
  const open = toMinutes(HOURS.open);
  const close = toMinutes(HOURS.close);
  if (start < open || start + service.minutes > close || (start - open) % HOURS.step !== 0) {
    throw invalid('time', 'Please pick one of the times shown.');
  }
  if (start < notBeforeFor(input.date, now, BOOKING_WINDOW.minNoticeMinutes)) {
    throw invalid('time', 'That time is too soon. Please pick a later one.');
  }

  // Bots get an answer that looks real, and nothing is stored.
  if (looksAutomated(body)) return created(input, service, newRef(), phone);

  const [{ results }, external] = await Promise.all([
    env.DB.prepare('SELECT start, end FROM blocks WHERE date = ?1').bind(input.date).all(),
    externalBusy(env),
  ]);
  const busy = mergeRanges([...parseRanges(results.map((row) => [row.start, row.end])), ...busyOn(external, input.date)]);
  if (busy.some(([s, e]) => overlaps(start, start + service.minutes, s, e))) {
    throw new HttpError(409, 'taken', 'Sorry, that time has just been booked. Please pick another.');
  }

  // A double tap or a resend within 10 minutes reuses the first request.
  const recent = await env.DB.prepare(
    "SELECT ref FROM booking_requests WHERE phone = ?1 AND date = ?2 AND start = ?3 AND status = 'pending' AND created_at > ?4 LIMIT 1",
  )
    .bind(input.phone, input.date, input.time, Date.now() - 600_000)
    .first();
  if (recent) return created(input, service, recent.ref, phone);

  await enforce(env, 'booking', client, 'You have sent a few booking requests already. Please wait a while, or message us on WhatsApp.');
  await enforce(env, 'bookingAll', 'all', 'We are receiving a lot of requests right now. Please message us on WhatsApp instead.');

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const ref = newRef();
    try {
      await env.DB.prepare(
        'INSERT INTO booking_requests (ref, name, phone, service, date, start, minutes, status, created_at) ' +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8)",
      )
        .bind(ref, input.name, input.phone, input.service, input.date, input.time, service.minutes, Date.now())
        .run();
      alertInBackground(ctx);
      return created(input, service, ref, phone);
    } catch (error) {
      if (!String(error && error.message).includes('UNIQUE')) throw error;
    }
  }
  throw new Error('could not allocate a booking reference');
}

