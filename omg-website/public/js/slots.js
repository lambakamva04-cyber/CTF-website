// Time-slot and date arithmetic shared by the website and the Worker.
//
// Pure functions: no clocks (the caller passes "now" in), no DOM, no network.
// A time of day is a whole number of minutes since midnight; "HH:MM" strings
// appear only at the edges. A date is a "YYYY-MM-DD" string in SAST. Ranges are
// half-open, [start, end), so 09:00–10:30 and 10:30–12:00 do not overlap.

const TIME_RE = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** True for "00:00" to "23:59", and "24:00" (the end of the day). */
export function isTime(value) {
  return typeof value === 'string' && TIME_RE.test(value);
}

/** "09:30" → 570. NaN when `value` is not a valid time. */
export function toMinutes(value) {
  if (!isTime(value)) return NaN;
  return value === '24:00' ? 1440 : Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

/** 570 → "09:30". */
export function toHHMM(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** True only for a real calendar date written as YYYY-MM-DD. */
export function isDate(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** True for "YYYY-MM" with a month from 01 to 12. */
export function isMonth(value) {
  if (typeof value !== 'string') return false;
  const match = MONTH_RE.exec(value);
  return !!match && Number(match[2]) >= 1 && Number(match[2]) <= 12;
}

function dateToDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function dayToDate(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** "2026-12-31" + 1 → "2027-01-01". */
export function addDays(date, days) {
  return dayToDate(dateToDay(date) + days);
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a, b) {
  return dateToDay(b) - dateToDay(a);
}

/** 0 = Monday … 6 = Sunday. */
export function weekday(date) {
  return (new Date(dateToDay(date) * DAY_MS).getUTCDay() + 6) % 7;
}

/** "2026-12-12" → "2026-12". */
export function monthOf(date) {
  return date.slice(0, 7);
}

/** "2026-12" + 1 → "2027-01". */
export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** Number of days in "YYYY-MM". */
export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Every date in "YYYY-MM", in order. */
export function datesInMonth(month) {
  const out = [];
  for (let d = 1; d <= daysInMonth(month); d += 1) out.push(`${month}-${String(d).padStart(2, '0')}`);
  return out;
}

/**
 * The current date and time of day in a fixed-offset zone (SAST is +120).
 * `nowMs` defaults to the real clock; tests pass a fixed instant.
 */
export function nowInZone(offsetMinutes, nowMs = Date.now()) {
  const shifted = new Date(nowMs + offsetMinutes * 60_000);
  return {
    date: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/**
 * On `date`, the first minute at which an appointment may start, given the
 * current moment and the minimum notice. 0 for dates far enough ahead; more
 * than 1440 when nothing on that date is far enough ahead.
 */
export function notBeforeFor(date, now, minNoticeMinutes) {
  const earliest = daysBetween(date, now.date) * 1440 + now.minutes + minNoticeMinutes;
  return Math.max(0, earliest);
}

/**
 * Turns [["09:00","10:30"], ...] into sorted, merged minute ranges. Pairs that
 * are malformed or empty are dropped.
 */
export function parseRanges(pairs) {
  const ranges = [];
  for (const pair of pairs || []) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const start = toMinutes(pair[0]);
    const end = toMinutes(pair[1]);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) ranges.push([start, end]);
  }
  return mergeRanges(ranges);
}

/** Sorts minute ranges and merges any that overlap or touch. */
export function mergeRanges(ranges) {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Merged minute ranges back to [["09:00","10:30"], ...]. */
export function formatRanges(ranges) {
  return mergeRanges(ranges).map(([s, e]) => [toHHMM(s), toHHMM(e)]);
}

/** True when [aStart, aEnd) and [bStart, bEnd) share any minute. */
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Every start time on the day's grid for an appointment of `minutes`, with
 * whether it can be booked.
 *
 * @param {object} o
 * @param {number[][]} o.busy     merged minute ranges already taken
 * @param {number} o.minutes      length of the appointment
 * @param {number} o.open         first possible start, in minutes
 * @param {number} o.close        everything must finish by this, in minutes
 * @param {number} o.step         minutes between start times
 * @param {number} [o.notBefore]  no start earlier than this (minimum notice)
 * @returns {{ start: number, free: boolean }[]}
 */
export function startTimes({ busy, minutes, open, close, step, notBefore = 0 }) {
  const out = [];
  for (let start = open; start + minutes <= close; start += step) {
    const free = start >= notBefore && !busy.some(([s, e]) => overlaps(start, start + minutes, s, e));
    out.push({ start, free });
  }
  return out;
}

/** True when `start` is on the grid, inside the hours, and fully free. */
export function isBookable({ busy, minutes, start, open, close, step, notBefore = 0 }) {
  if (!Number.isInteger(start) || start < open || start + minutes > close) return false;
  if ((start - open) % step !== 0) return false;
  if (start < notBefore) return false;
  return !busy.some(([s, e]) => overlaps(start, start + minutes, s, e));
}
