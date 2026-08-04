// Period boundaries are computed in the client's own timezone. A dental
// practice in Johannesburg asking for "today" means their calendar day, not
// UTC's — getting this wrong shifts every metric by two hours.

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(date: Date, timeZone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl renders midnight as "24" in some locales' hour12:false output.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC epoch ms of local midnight, `dayOffset` days from the given instant. */
export function startOfLocalDay(at: Date, timeZone: string, dayOffset = 0): number {
  const p = localParts(at, timeZone);
  const guess = Date.UTC(p.year, p.month - 1, p.day + dayOffset, 0, 0, 0);
  return guess - offsetMs(new Date(guess), timeZone);
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Day of week as seen in `timeZone` (0 = Sunday). Read from Intl rather than
 * from the local-midnight instant, whose UTC weekday is the previous day for
 * any zone east of Greenwich.
 */
function localWeekdayIndex(at: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at);
  return WEEKDAY_NAMES.indexOf(name);
}

/** Local midnight at the start of the current week (Monday). */
export function startOfLocalWeek(at: Date, timeZone: string): number {
  const weekday = localWeekdayIndex(at, timeZone);
  const daysSinceMonday = (weekday + 6) % 7;
  return startOfLocalDay(at, timeZone, -daysSinceMonday);
}

/** Local midnight on the first day of the current month. */
export function startOfLocalMonth(at: Date, timeZone: string): number {
  const p = localParts(at, timeZone);
  const guess = Date.UTC(p.year, p.month - 1, 1, 0, 0, 0);
  return guess - offsetMs(new Date(guess), timeZone);
}

export function localWeekdayLabel(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-ZA', { timeZone, weekday: 'short' }).format(new Date(epochMs));
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
