// OMG's own phone calendar, both ways.
//
// Out: a private iCalendar feed of confirmed bookings and time off. OMG
// subscribes to it once (iPhone: "Add to iPhone Calendar"; Google: "From
// URL"), and website bookings appear among her other appointments. The link
// holds a long random token; "Make a new link" replaces it.
//
// In: her calendar's private iCal link (iCloud "Public Calendar", Google
// "Secret address in iCal format", Outlook "ICS" link). Every 15 minutes the
// Worker reads it and keeps only the busy times (never titles or details), so
// the website's calendar shows when she is really free. If a read fails, the
// last busy times are kept and the admin page says what went wrong.

import { UTC_OFFSET_MINUTES } from '../public/js/catalog.js';
import { addDays, isDate, mergeRanges, nowInZone, toMinutes } from '../public/js/slots.js';
import { guard } from './admin.js';
import { HttpError, invalid, json, readJson } from './http.js';
import { enforce } from './ratelimit.js';

const DAY_MS = 86_400_000;
const OFFSET_MS = UTC_OFFSET_MINUTES * 60_000;
const TOKEN = /^[a-f0-9]{48}$/;
const MAX_ICS_BYTES = 3 * 1024 * 1024;
const MAX_STEPS = 5000; // occurrences one rule may count, so no rule can run away
/** iCloud, Google and Outlook: the only places a calendar link may point. */
const IMPORT_HOSTS = [
  /^p\d{1,3}-caldav\.icloud\.com$/,
  /^p\d{1,3}-calendars\.icloud\.com$/,
  /^calendar\.google\.com$/,
  /^outlook\.(?:live|office365|office)\.com$/,
];
/** Zones on South African time all year. Unknown zones are read as SAST too. */
const SAST_ZONES = new Set([
  'Africa/Johannesburg', 'Africa/Maseru', 'Africa/Mbabane', 'Africa/Harare', 'Africa/Maputo', 'Africa/Gaborone',
  'Africa/Lusaka', 'Africa/Blantyre', 'South Africa Standard Time',
]);

const upsert = (env, key, value) =>
  env.DB.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(key, value);
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const pad = (n, w = 2) => String(n).padStart(w, '0');

// ---------------------------------------------------------------- out: the feed

/** iCalendar TEXT: backslash, ";", "," and new lines escaped; control characters dropped. */
export function icsText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n|\r/g, '\\n');
}

/** Lines longer than 75 octets continue on the next line after a space (RFC 5545). */
export function foldLine(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (bytes + n > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += n;
  }
  parts.push(current);
  return parts.map((p, i) => (i ? ` ${p}` : p)).join('\r\n');
}

const icsUtc = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};
const sastMs = (date, minutes) => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d) + minutes * 60_000 - OFFSET_MS;
};

/** The feed: one event per booking or time off, in UTC, all-day where it is a whole day. */
export function buildIcs(blocks, now = Date.now()) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OMG Oh My Glam//Bookings//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:OMG bookings', 'X-WR-TIMEZONE:Africa/Johannesburg', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M',
  ];
  const stamp = icsUtc(now);
  for (const b of blocks) {
    const start = toMinutes(b.start);
    const end = toMinutes(b.end);
    if (!isDate(b.date) || !(end > start)) continue;
    const closed = b.kind === 'closed';
    const summary = closed
      ? (b.label ? `Time off: ${b.label}` : 'Time off')
      : [b.service_name, b.name || b.label].filter(Boolean).join(' · ') || 'Booking';
    const details = closed ? [] : [b.phone && `Phone: ${b.phone}`, b.ref && `Ref: ${b.ref}`, b.ref && 'Booked on the website'].filter(Boolean);
    lines.push('BEGIN:VEVENT', `UID:omg-block-${b.id}@omg-oh-my-glam`, `DTSTAMP:${stamp}`);
    if (start === 0 && end === 1440) {
      lines.push(`DTSTART;VALUE=DATE:${b.date.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${addDays(b.date, 1).replace(/-/g, '')}`);
    } else {
      lines.push(`DTSTART:${icsUtc(sastMs(b.date, start))}`, `DTEND:${icsUtc(sastMs(b.date, end))}`);
    }
    lines.push(`SUMMARY:${icsText(summary)}`);
    if (details.length) lines.push(`DESCRIPTION:${icsText(details.join('\n'))}`);
    lines.push('TRANSP:OPAQUE', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

async function sameToken(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}

/**
 * GET /calendar/<token>.ics: the feed her calendar app subscribes to. Rate
 * limited like everything else, wrong tokens included, so guessing is slower
 * still than the 192 random bits already make it.
 */
export async function feed(request, env, token, client) {
  const text = (status, body, extra = {}) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra } });
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return text(405, 'Method not allowed', { allow: 'GET, HEAD' });
  try {
    await enforce(env, 'calendarFeed', client);
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) return text(429, 'Too many requests', { 'retry-after': String(error.extra.retryAfter || 60) });
    throw error;
  }
  if (!TOKEN.test(token)) return text(404, 'Not found');
  const rows = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('calendar_feed_token', 'calendar_feed_seen')").all();
  const saved = Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
  if (!saved.calendar_feed_token || !(await sameToken(token, saved.calendar_feed_token))) return text(404, 'Not found');
  const now = Date.now();
  const today = nowInZone(UTC_OFFSET_MINUTES, now).date;
  const [{ results }] = await Promise.all([
    env.DB.prepare(
      'SELECT b.id, b.date, b.start, b.end, b.kind, b.label, r.ref, r.name, r.phone, s.name AS service_name '
      + 'FROM blocks b LEFT JOIN booking_requests r ON r.id = b.request_id LEFT JOIN services s ON s.id = r.service '
      + 'WHERE b.date >= ?1 AND b.date <= ?2 ORDER BY b.date, b.start, b.id LIMIT 5000',
    ).bind(addDays(today, -60), addDays(today, 400)).all(),
    // So the admin page can say her calendar app is collecting bookings (written at most every 10 minutes).
    Number(saved.calendar_feed_seen) > now - 600_000 ? null : upsert(env, 'calendar_feed_seen', String(now)).run(),
  ]);
  return new Response(method === 'HEAD' ? null : buildIcs(results, now), {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="omg-bookings.ics"',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

/** The feed's token, made on first use (the INSERT OR IGNORE settles a race between two first uses). */
async function feedState(env, reset) {
  if (reset) {
    await env.DB.batch([
      upsert(env, 'calendar_feed_token', randomHex(24)),
      env.DB.prepare("DELETE FROM settings WHERE key = 'calendar_feed_seen'"),
    ]);
  } else {
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('calendar_feed_token', ?1)").bind(randomHex(24)).run();
  }
  const rows = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('calendar_feed_token', 'calendar_feed_seen')").all();
  const saved = Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
  return { token: saved.calendar_feed_token, seen: Number(saved.calendar_feed_seen) || 0 };
}

const feedOut = (origin, { token, seen }) => {
  const https = `${origin}/calendar/${token}.ics`;
  return { https, webcal: https.replace(/^https?:/, 'webcal:'), seenAt: seen ? new Date(seen).toISOString() : null };
};

// ---------------------------------------------------------------- in: reading her calendar

/** Her calendar's link, checked: iCloud, Google or Outlook only; webcal:// becomes https://. */
export function importUrl(value) {
  const message = 'Paste the private calendar link from your iPhone, Google or Outlook calendar.';
  const text = typeof value === 'string' ? value.trim().replace(/^webcals?:\/\//i, 'https://') : '';
  if (!text || text.length > 2000) throw invalid('url', message);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw invalid('url', message);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port || !IMPORT_HOSTS.some((re) => re.test(url.hostname))) {
    throw invalid('url', 'That link is not from iCloud, Google Calendar or Outlook.');
  }
  url.protocol = 'https:';
  return url.href;
}

/** The body as bytes, refusing anything over `maxBytes`. */
async function readBytes(body, maxBytes) {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(422, 'calendar_too_large', 'That calendar is too large to read. Share a calendar with only your appointments.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
/** A validator worth sending back (ETag or Last-Modified): short, printable, nothing that could break a header. */
const validator = (value) => (typeof value === 'string' && /^[\x20-\x7e]{1,200}$/.test(value) ? value : null);

/**
 * Downloads the calendar, following at most 3 redirects, each to an allowed
 * host, within 20 seconds. Sends back the last ETag or Last-Modified, so an
 * unchanged calendar can answer "not modified" without sending itself again.
 * Failures are 422s: the link she gave didn't work, which is not a fault in
 * the website.
 *
 * @returns {{ notModified: true } | { text: string, hash: string, etag: string|null, lastModified: string|null }}
 */
export async function fetchCalendar(href, { fetchImpl = fetch, etag = null, lastModified = null } = {}) {
  const headers = { accept: 'text/calendar, */*;q=0.1' };
  if (validator(etag)) headers['if-none-match'] = etag;
  if (validator(lastModified)) headers['if-modified-since'] = lastModified;
  let url = href;
  for (let hop = 0; hop < 4; hop += 1) {
    let res;
    try {
      res = await fetchImpl(url, { redirect: 'manual', headers, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new HttpError(422, 'calendar_unreachable', 'Your calendar could not be reached. Try again in a few minutes.');
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      try {
        url = importUrl(new URL(location, url).href); // each hop must stay on iCloud, Google or Outlook
      } catch {
        throw new HttpError(422, 'calendar_unreachable', 'Your calendar link led somewhere other than your calendar.');
      }
      continue;
    }
    if (res.status === 304 && (headers['if-none-match'] || headers['if-modified-since'])) return { notModified: true };
    if (!res.ok) {
      throw new HttpError(422, 'calendar_unreachable', `Your calendar link answered with an error (${res.status}). Check that the calendar is still shared.`);
    }
    let bytes;
    try {
      bytes = await readBytes(res.body, MAX_ICS_BYTES);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(422, 'calendar_unreachable', 'Your calendar stopped answering part-way. Try again in a few minutes.');
    }
    const text = new TextDecoder().decode(bytes);
    if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 4000))) {
      throw new HttpError(422, 'calendar_unreadable', 'That link did not return a calendar.');
    }
    return {
      text,
      hash: hex(await crypto.subtle.digest('SHA-256', bytes)),
      etag: validator(res.headers.get('etag')),
      lastModified: validator(res.headers.get('last-modified')),
    };
  }
  throw new HttpError(422, 'calendar_unreachable', 'Your calendar link redirects too many times.');
}

// The only lines read from her calendar; titles, notes, places and guests are never looked at.
const WANTED = 'DTSTART|DTEND|DURATION|RRULE|EXDATE|RECURRENCE-ID|UID|STATUS|TRANSP';
const LINE = `\\n(?:(BEGIN|END):([A-Za-z0-9-]+)|(${WANTED})([;:][^\\r\\n]*))`;
const NO_PARAMS = Object.freeze({});

/** "TZID=x;VALUE=DATE:20261116" → { params, value }, with ":" allowed inside quoted parameters. */
function splitProperty(rest) {
  if (rest[0] === ':') return { params: NO_PARAMS, value: rest.slice(1).trim() };
  let colon = -1;
  if (!rest.includes('"')) colon = rest.indexOf(':');
  else {
    for (let i = 1, quoted = false; i < rest.length; i += 1) {
      if (rest[i] === '"') quoted = !quoted;
      else if (rest[i] === ':' && !quoted) {
        colon = i;
        break;
      }
    }
  }
  if (colon < 0) return null;
  const params = {};
  const head = rest.slice(1, colon);
  for (const p of head.includes('"') ? head.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/) : head.split(';')) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { params, value: rest.slice(colon + 1).trim() };
}

/**
 * Each VEVENT as { NAME: raw line after the name } for the WANTED properties
 * (EXDATE as a list); nested parts (alarms) and time-zone rules are skipped.
 * One pass of one expression over the file, without splitting it into lines,
 * and nothing is unpacked until it's needed: a busy calendar is read well
 * inside the free plan's CPU allowance.
 */
export function parseEvents(text) {
  // Names are upper case in every calendar app's files; any other case is read too, a little slower.
  const re = new RegExp(LINE, text.includes('BEGIN:VEVENT') || !/begin:vevent/i.test(text) ? 'g' : 'gi');
  const events = [];
  let current = null;
  let depth = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[1]) {
      if (m[1].length === 5) { // BEGIN
        if (current) depth += 1;
        else if (m[2].toUpperCase() === 'VEVENT') {
          current = {};
          depth = 1;
        }
      } else if (current && --depth === 0) {
        events.push(current);
        current = null;
      }
      continue;
    }
    if (!current || depth !== 1) continue;
    // A long line continues on the next ones, each starting with a space or tab.
    let rest = m[4];
    let pos = re.lastIndex;
    for (;;) {
      const next = text[pos] === '\r' && text[pos + 1] === '\n' ? pos + 2 : text[pos] === '\n' ? pos + 1 : -1;
      if (next < 0 || (text[next] !== ' ' && text[next] !== '\t')) break;
      const lf = text.indexOf('\n', next);
      const stop = lf < 0 ? text.length : text[lf - 1] === '\r' ? lf - 1 : lf;
      rest += text.slice(next + 1, stop);
      pos = stop;
    }
    re.lastIndex = pos;
    const name = m[3].toUpperCase();
    if (name === 'EXDATE') (current.EXDATE ||= []).push(rest);
    else if (current[name] === undefined) current[name] = rest;
  }
  return events;
}

/** A date, date-time or keyword value: what follows the last ":" (those values never hold one). */
const lastValue = (raw) => raw.slice(raw.lastIndexOf(':') + 1).trim();
const unpack = (raw) => (raw ? splitProperty(raw) : null);

/** A date or date-time value as wall-clock parts in its zone ('UTC', a TZID, or 'local' for SAST). */
export function parseWhen(value, params = {}) {
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (date || params.VALUE === 'DATE') {
    const m = date || /^(\d{4})(\d{2})(\d{2})/.exec(value);
    return m && { y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0, allDay: true, zone: 'local' };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(value);
  if (!m) return null;
  const zone = m[7] ? 'UTC' : params.TZID ? params.TZID.replace(/^\//, '') : 'local';
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], allDay: false, zone };
}

const formatters = new Map();
const offsets = new Map();
function zoneOffsetMinutes(zone, utcMs) {
  if (zone === 'UTC') return 0;
  if (zone === 'local' || SAST_ZONES.has(zone)) return UTC_OFFSET_MINUTES;
  let format = formatters.get(zone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    } catch {
      format = null; // a name Intl doesn't know (e.g. Windows zone names): read as SAST
    }
    formatters.set(zone, format);
  }
  if (!format) return UTC_OFFSET_MINUTES;
  const key = `${zone}|${Math.floor(utcMs / 3_600_000)}`;
  let offset = offsets.get(key);
  if (offset === undefined) {
    const p = Object.fromEntries(format.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
    offset = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - Math.floor(utcMs / 60_000) * 60_000) / 60_000);
    if (offsets.size > 20_000) offsets.clear();
    offsets.set(key, offset);
  }
  return offset;
}

/** Wall-clock parts in a zone → epoch ms. */
export function wallToUtc(t, zone) {
  const guess = Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi);
  const first = zoneOffsetMinutes(zone, guess);
  const second = zoneOffsetMinutes(zone, guess - first * 60_000);
  return guess - second * 60_000;
}

const dayNum = (y, mo, d) => Date.UTC(y, mo - 1, d) / DAY_MS;
/** Day number → { y, mo, d }, by arithmetic (H. Hinnant's civil_from_days). */
function fromDayNum(n) {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const mo = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (mo <= 2 ? 1 : 0), mo, d: doy - Math.floor((153 * mp + 2) / 5) + 1 };
}
const weekdayOf = (n) => (((n + 3) % 7) + 7) % 7; // 0 = Monday; day 0 (1 Jan 1970) was a Thursday
const dayToDate = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const dateToDay = (date) => dayNum(+date.slice(0, 4), +date.slice(5, 7), +date.slice(8, 10));
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** ISO 8601 duration (P1D, PT1H30M, P1W) → ms; null when unreadable. */
export function durationMs(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value || '');
  if (!m || value === 'P' || value === 'PT') return null;
  const ms = (((+m[2] || 0) * 7 + (+m[3] || 0)) * 24 * 3600 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

const daysIn = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

/** The days of one month a MONTHLY or YEARLY rule picks: BYDAY (MO, 1MO, -1FR), BYMONTHDAY, or the start's day. */
function monthDays(y, mo, parts, startDay) {
  const last = daysIn(y, mo);
  const byMonthDay = parts.BYMONTHDAY
    ? parts.BYMONTHDAY.split(',').map(Number).filter(Number.isInteger).map((n) => (n > 0 ? n : last + n + 1)).filter((d) => d >= 1 && d <= last)
    : null;
  if (!parts.BYDAY) return byMonthDay ? [...new Set(byMonthDay)].sort((a, b) => a - b) : startDay <= last ? [startDay] : [];
  const firstWeekday = weekdayOf(dayNum(y, mo, 1));
  const days = [];
  for (const spec of parts.BYDAY.split(',')) {
    const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(spec.trim());
    if (!m) continue;
    const all = [];
    for (let d = 1 + ((DAYS.indexOf(m[2]) - firstWeekday + 7) % 7); d <= last; d += 7) all.push(d);
    const nth = m[1] ? Number(m[1]) : 0;
    if (!nth) days.push(...all);
    else if (nth > 0 && all[nth - 1]) days.push(all[nth - 1]);
    else if (nth < 0 && all[all.length + nth]) days.push(all[all.length + nth]);
  }
  const picked = byMonthDay ? days.filter((d) => byMonthDay.includes(d)) : days;
  return [...new Set(picked)].sort((a, b) => a - b);
}

/**
 * The days (as day numbers) from `fromDay` to `toDay` on which a recurring
 * event starts, by its RRULE: DAILY, WEEKLY (BYDAY), MONTHLY (BYMONTHDAY, or
 * BYDAY such as 1MO or -1FR) and YEARLY (BYMONTH too), with INTERVAL and COUNT.
 * COUNT is counted from the event's first day; without it, the rule skips
 * straight to the window, so an event repeating since years ago costs nothing.
 */
export function recurrenceDays(firstDay, rule, fromDay, toDay) {
  const parts = Object.fromEntries(rule.split(';').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim().toUpperCase(), v.trim().toUpperCase()]));
  const interval = Math.min(1000, Math.max(1, Math.floor(Number(parts.INTERVAL)) || 1));
  const count = Number(parts.COUNT) >= 1 ? Math.floor(Number(parts.COUNT)) : Infinity;
  const skip = count === Infinity; // safe to jump ahead: nothing before the window needs counting
  const out = [];
  let seen = 0;
  const emit = (n) => {
    if (n < firstDay) return true; // before the first day is not an occurrence
    if (n > toDay || seen >= count || seen >= MAX_STEPS) return false;
    seen += 1;
    if (n >= fromDay) out.push(n);
    return true;
  };
  const first = fromDayNum(firstDay);
  const from = fromDayNum(Math.max(firstDay, fromDay));
  const periodsBefore = (gap) => (skip && gap > 0 ? Math.floor(gap / interval) * interval : 0);
  if (parts.FREQ === 'DAILY') {
    for (let n = firstDay + periodsBefore(Math.max(firstDay, fromDay) - firstDay); emit(n); n += interval);
  } else if (parts.FREQ === 'WEEKLY') {
    const days = [...new Set((parts.BYDAY || DAYS[weekdayOf(firstDay)]).split(',').map((d) => DAYS.indexOf(d.trim().slice(-2))).filter((i) => i >= 0))].sort((a, b) => a - b);
    const weekStart = firstDay - weekdayOf(firstDay);
    const weeks = periodsBefore(Math.floor((Math.max(firstDay, fromDay) - weekStart) / 7));
    for (let w = weekStart + weeks * 7, go = days.length > 0; go && w <= toDay; w += 7 * interval) {
      for (const i of days) if (!(go = emit(w + i))) break;
    }
  } else if (parts.FREQ === 'MONTHLY') {
    for (let k = periodsBefore((from.y - first.y) * 12 + from.mo - first.mo), go = true; go; k += interval) {
      const y = first.y + Math.floor((first.mo - 1 + k) / 12);
      const mo = ((first.mo - 1 + k) % 12) + 1;
      if (dayNum(y, mo, 1) > toDay) break;
      for (const d of monthDays(y, mo, parts, first.d)) if (!(go = emit(dayNum(y, mo, d)))) break;
    }
  } else if (parts.FREQ === 'YEARLY') {
    const months = parts.BYMONTH ? [...new Set(parts.BYMONTH.split(',').map(Number).filter((m) => m >= 1 && m <= 12))].sort((a, b) => a - b) : [first.mo];
    const byDays = parts.BYDAY || parts.BYMONTHDAY ? parts : {};
    for (let k = periodsBefore(from.y - first.y), go = months.length > 0; go; k += interval) {
      const y = first.y + k;
      if (dayNum(y, 1, 1) > toDay) break;
      for (const mo of months) {
        for (const d of monthDays(y, mo, byDays, first.d)) if (!(go = emit(dayNum(y, mo, d)))) break;
        if (!go) break;
      }
    }
  } else {
    emit(firstDay);
  }
  return out;
}

/** Busy [start, end) intervals (epoch ms) from a calendar's events, inside the window. */
export function busyIntervals(events, fromMs, toMs) {
  const lastDay = Math.floor(toMs / DAY_MS) + 2;
  const overridden = new Map(); // UID → instance starts moved or changed by RECURRENCE-ID
  for (const ev of events) {
    if (!ev['RECURRENCE-ID'] || !ev.UID) continue;
    const rid = unpack(ev['RECURRENCE-ID']);
    const uid = unpack(ev.UID)?.value;
    const when = rid && parseWhen(rid.value, rid.params);
    if (when && uid) {
      if (!overridden.has(uid)) overridden.set(uid, new Set());
      overridden.get(uid).add(when.allDay ? `d${dayNum(when.y, when.mo, when.d)}` : String(wallToUtc(when, when.zone)));
    }
  }
  // Anything that ended two days or more before the window is passed over on
  // its date digits alone: most of a calendar is its past.
  const cutoff = new Date(fromMs - 2 * DAY_MS).toISOString().slice(0, 10).replace(/-/g, '');
  const out = [];
  for (const ev of events) {
    if (!ev.RRULE) {
      const last = ev.DTEND || (!ev.DURATION && ev.DTSTART);
      if (last && lastValue(last).slice(0, 8) < cutoff) continue;
    }
    if ((ev.STATUS && lastValue(ev.STATUS).toUpperCase() === 'CANCELLED') || (ev.TRANSP && lastValue(ev.TRANSP).toUpperCase() === 'TRANSPARENT')) continue;
    const dtstart = unpack(ev.DTSTART);
    const start = dtstart && parseWhen(dtstart.value, dtstart.params);
    if (!start) continue;
    const dtend = unpack(ev.DTEND);
    const end = dtend && parseWhen(dtend.value, dtend.params);
    const startMs = start.allDay ? Date.UTC(start.y, start.mo - 1, start.d) - OFFSET_MS : wallToUtc(start, start.zone);
    let length;
    if (end) length = (end.allDay ? Date.UTC(end.y, end.mo - 1, end.d) - OFFSET_MS : wallToUtc(end, end.zone)) - startMs;
    else if (ev.DURATION) length = durationMs(lastValue(ev.DURATION));
    else length = start.allDay ? DAY_MS : 0;
    if (!(length > 0)) continue;
    const rule = unpack(ev.RRULE)?.value;
    if (!rule || ev['RECURRENCE-ID']) {
      if (startMs < toMs && startMs + length > fromMs) out.push([startMs, startMs + length]);
      continue;
    }
    const untilRaw = /(?:^|;)UNTIL=([0-9TZ]+)/i.exec(rule)?.[1];
    const until = untilRaw && parseWhen(untilRaw.toUpperCase(), start.allDay ? { VALUE: 'DATE' } : {});
    // UNTIL is the last start allowed: a date covers that whole day; a floating time is in the event's zone.
    const untilMs = !until ? Infinity
      : until.allDay ? Date.UTC(until.y, until.mo - 1, until.d) + DAY_MS - OFFSET_MS - 1
        : wallToUtc(until, until.zone === 'local' ? start.zone : until.zone);
    const skip = new Set(overridden.get(unpack(ev.UID)?.value) || []);
    for (const raw of ev.EXDATE || []) {
      const ex = splitProperty(raw);
      for (const v of ex ? ex.value.split(',') : []) {
        const w = parseWhen(v.trim(), ex.params);
        if (w) skip.add(w.allDay || start.allDay ? `d${dayNum(w.y, w.mo, w.d)}` : String(wallToUtc(w, w.zone === 'local' ? start.zone : w.zone)));
      }
    }
    const fromDay = Math.floor((fromMs + OFFSET_MS - length) / DAY_MS) - 1; // starts this early can still run into the window
    const toDay = Math.min(lastDay, until ? dayNum(until.y, until.mo, until.d) + 1 : lastDay);
    for (const n of recurrenceDays(dayNum(start.y, start.mo, start.d), rule, fromDay, toDay)) {
      const d = fromDayNum(n);
      const s = start.allDay ? Date.UTC(d.y, d.mo - 1, d.d) - OFFSET_MS : wallToUtc({ ...d, h: start.h, mi: start.mi }, start.zone);
      if (s > untilMs || s >= toMs) break;
      if (skip.has(`d${n}`) || skip.has(String(s))) continue;
      if (s + length > fromMs) out.push([s, s + length]);
    }
  }
  return out;
}

/** Intervals → { 'YYYY-MM-DD': [[600, 690], ...] } (minutes in SAST, merged), between two dates. */
export function busyByDate(intervals, fromDate, toDate) {
  const fromDay = dateToDay(fromDate);
  const toDay = dateToDay(toDate);
  const windowStart = fromDay * DAY_MS - OFFSET_MS;
  const windowEnd = (toDay + 1) * DAY_MS - OFFSET_MS;
  const days = new Map();
  for (const [s, e] of intervals) {
    const last = Math.min(e, windowEnd);
    for (let t = Math.max(s, windowStart); t < last;) {
      const day = Math.floor((t + OFFSET_MS) / DAY_MS);
      const dayStart = day * DAY_MS - OFFSET_MS;
      const segEnd = Math.min(last, dayStart + DAY_MS);
      const from = Math.floor((t - dayStart) / 60_000);
      const to = Math.min(1440, Math.ceil((segEnd - dayStart) / 60_000));
      if (to > from) {
        if (!days.has(day)) days.set(day, []);
        days.get(day).push([from, to]);
      }
      t = segEnd;
    }
  }
  return Object.fromEntries([...days.keys()].sort((a, b) => a - b).map((day) => [dayToDate(day), mergeRanges(days.get(day))]));
}

/** The busy times in a calendar file, from yesterday to 400 days ahead (SAST). */
export function busyFromIcs(text, now = Date.now()) {
  const today = nowInZone(UTC_OFFSET_MINUTES, now).date;
  const from = addDays(today, -1);
  const to = addDays(today, 400);
  return busyByDate(busyIntervals(parseEvents(text), sastMs(from, 0), sastMs(addDays(to, 1), 0)), from, to);
}

const RECOMPUTE_MS = 7 * DAY_MS; // the 400 days read reach well past the year that can be booked
const countTimes = (busy) => Object.values(busy).reduce((n, r) => n + r.length, 0);

async function lastStatus(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'calendar_import_status'").first();
  try {
    const status = row ? JSON.parse(row.value) : null;
    return status && typeof status === 'object' ? status : {};
  } catch {
    return {};
  }
}

/** What is stored about a good read. */
function readStatus(got, busy, now) {
  return {
    ok: true, checkedAt: now, readAt: now, computedAt: now,
    hash: got.hash, etag: got.etag, lastModified: got.lastModified,
    days: Object.keys(busy).length, times: countTimes(busy),
  };
}

/**
 * Reads her calendar and stores its busy times. An unchanged calendar (the
 * server says "not modified", or the file is byte for byte the same) is not
 * worked out again, so the run every 15 minutes costs next to nothing. A
 * failed read keeps the last busy times (a little old beats none) and records
 * what went wrong. Returns the status, or null when no calendar is linked.
 */
export async function syncCalendar(env, { fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'calendar_import_url'").first();
  if (!row) return null;
  const before = await lastStatus(env);
  // Worked out at least weekly, so the 400 days ahead never run short.
  const fresh = !force && before.ok === true && now - (before.computedAt || 0) < RECOMPUTE_MS;
  try {
    const got = await fetchCalendar(row.value, { fetchImpl, ...(fresh ? { etag: before.etag, lastModified: before.lastModified } : {}) });
    if (got.notModified || (fresh && got.hash === before.hash)) {
      const status = { ...before, ok: true, checkedAt: now, readAt: now, error: undefined };
      await upsert(env, 'calendar_import_status', JSON.stringify(status)).run();
      return status;
    }
    const busy = busyFromIcs(got.text, now);
    const status = readStatus(got, busy, now);
    await env.DB.batch([upsert(env, 'calendar_busy', JSON.stringify(busy)), upsert(env, 'calendar_import_status', JSON.stringify(status))]);
    return status;
  } catch (error) {
    console.warn('calendar_sync_failed', String(error && error.message));
    const status = {
      ...before,
      ok: false,
      checkedAt: now,
      error: error instanceof HttpError ? error.message : 'Your calendar could not be read. Try again in a few minutes.',
    };
    await upsert(env, 'calendar_import_status', JSON.stringify(status)).run();
    return status;
  }
}

// ---------------------------------------------------------------- admin routes

const SOURCES = [
  [/icloud\.com$/, 'iCloud'],
  [/google\.com$/, 'Google Calendar'],
  [/outlook\./, 'Outlook'],
];

/** What the admin page shows about the connected calendar. Never the link itself: it opens her whole calendar. */
async function importState(env) {
  const [url, status] = await Promise.all([
    env.DB.prepare("SELECT value FROM settings WHERE key = 'calendar_import_url'").first(),
    lastStatus(env),
  ]);
  if (!url) return { connected: false };
  let host = '';
  try {
    host = new URL(url.value).hostname;
  } catch {
    host = '';
  }
  return {
    connected: true,
    source: (SOURCES.find(([re]) => re.test(host)) || [null, 'your calendar'])[1],
    ok: status.ok === true,
    checkedAt: Number.isFinite(status.checkedAt) ? new Date(status.checkedAt).toISOString() : null,
    readAt: Number.isFinite(status.readAt) ? new Date(status.readAt).toISOString() : null,
    times: Number.isInteger(status.times) ? status.times : 0,
    error: status.ok === false && typeof status.error === 'string' ? status.error : null,
  };
}

/** GET /api/admin/calendar-sync: the feed's links and the connected calendar. */
export async function getSync(ctx) {
  await guard(ctx);
  const [feedNow, importNow] = await Promise.all([feedState(ctx.env, false), importState(ctx.env)]);
  return json({ ok: true, feed: feedOut(ctx.url.origin, feedNow), import: importNow });
}

/** POST /api/admin/calendar-sync/feed-reset: a new feed link; the old one stops working at once. */
export async function resetFeed(ctx) {
  await guard(ctx);
  await enforce(ctx.env, 'calendarSync', ctx.client);
  return json({ ok: true, feed: feedOut(ctx.url.origin, await feedState(ctx.env, true)) });
}

/** POST /api/admin/calendar-sync/import { url }: connects her calendar, once it has been read. */
export async function connectImport(ctx) {
  await guard(ctx);
  await enforce(ctx.env, 'calendarSync', ctx.client);
  const body = await readJson(ctx.request);
  const href = importUrl(body.url);
  const now = Date.now();
  const got = await fetchCalendar(href); // a link that doesn't work is refused, not saved
  const busy = busyFromIcs(got.text, now);
  const status = readStatus(got, busy, now);
  await ctx.env.DB.batch([
    upsert(ctx.env, 'calendar_import_url', href),
    upsert(ctx.env, 'calendar_busy', JSON.stringify(busy)),
    upsert(ctx.env, 'calendar_import_status', JSON.stringify(status)),
  ]);
  return json({ ok: true, import: await importState(ctx.env) });
}

/** POST /api/admin/calendar-sync/sync: reads her calendar now. */
export async function syncNow(ctx) {
  await guard(ctx);
  await enforce(ctx.env, 'calendarSync', ctx.client);
  const status = await syncCalendar(ctx.env, { force: true });
  if (!status) throw new HttpError(404, 'not_connected', 'No calendar is connected.');
  return json({ ok: true, import: await importState(ctx.env) });
}

/** DELETE /api/admin/calendar-sync/import: disconnects it and forgets its busy times. */
export async function disconnectImport(ctx) {
  await guard(ctx);
  await enforce(ctx.env, 'calendarSync', ctx.client);
  await ctx.env.DB.prepare("DELETE FROM settings WHERE key IN ('calendar_import_url', 'calendar_busy', 'calendar_import_status')").run();
  return json({ ok: true, import: { connected: false } });
}
