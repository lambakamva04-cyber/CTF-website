/**
 * South African calling hours, for Hope's callbacks.
 *
 * A callback is a reply to someone who asked for one, not a cold call, but it
 * still keeps to the hours the Consumer Protection Act sets for direct
 * marketing, and tighter: weekdays 08:00 to 18:00, Saturdays 09:00 to 13:00,
 * never on a Sunday or a public holiday. Somebody who fills in the form at ten
 * at night is called the next morning, not then.
 *
 * South Africa has one time zone, two hours ahead of UTC, with no daylight
 * saving, so local time is a fixed offset and needs no time zone database.
 */

const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

/** No call is started this close to the end of a window: a call can run five minutes. */
const LAST_CALL_MARGIN_MINUTES = 10;

/** Minutes after midnight, local time. */
const WEEKDAY_WINDOW = { from: 8 * 60, to: 18 * 60 };
const SATURDAY_WINDOW = { from: 9 * 60, to: 13 * 60 };

/**
 * Fixed-date public holidays (Public Holidays Act 36 of 1994), as MM-DD: New
 * Year's Day, Human Rights Day, Freedom Day, Workers' Day, Youth Day, National
 * Women's Day, Heritage Day, Day of Reconciliation, Christmas Day, Day of
 * Goodwill. Good Friday and Family Day move with Easter and are worked out
 * below. A one-off holiday the President declares, such as an election day, is
 * not known in advance; Hope would call on it, inside normal hours.
 */
const FIXED_HOLIDAYS = new Set([
  '01-01', '03-21', '04-27', '05-01', '06-16', '08-09', '09-24', '12-16', '12-25', '12-26',
]);

type LocalDate = { year: number; month: number; day: number };

function key(month: number, day: number): string {
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDays(date: LocalDate, days: number): LocalDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

function weekday(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Easter Sunday in the Gregorian calendar (the Meeus/Jones/Butcher algorithm). */
function easterSunday(year: number): LocalDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}

function sameDay(a: LocalDate, b: LocalDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function isNamedHoliday(date: LocalDate): boolean {
  if (FIXED_HOLIDAYS.has(key(date.month, date.day))) return true;
  const easter = easterSunday(date.year);
  return sameDay(date, addDays(easter, -2)) || sameDay(date, addDays(easter, 1));
}

/**
 * A South African public holiday. When one falls on a Sunday, the Monday after
 * it is a public holiday too (section 2(1) of the Act).
 */
export function isPublicHoliday(date: LocalDate): boolean {
  if (isNamedHoliday(date)) return true;
  const yesterday = addDays(date, -1);
  return weekday(date) === 1 && isNamedHoliday(yesterday);
}

/** The date and time in South Africa at the given instant. */
export function sastNow(now: Date): LocalDate & { weekday: number; minutes: number } {
  const local = new Date(now.getTime() + SAST_OFFSET_MS);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    weekday: local.getUTCDay(),
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

/** True when Hope may start a callback now. */
export function isCallingTime(now: Date): boolean {
  const local = sastNow(now);
  if (local.weekday === 0 || isPublicHoliday(local)) return false;
  const window = local.weekday === 6 ? SATURDAY_WINDOW : WEEKDAY_WINDOW;
  return local.minutes >= window.from && local.minutes < window.to - LAST_CALL_MARGIN_MINUTES;
}

/** "29 Sept 2026, 10:15", South African time, for emails. */
export function sastLabel(date: Date): string {
  return new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}
