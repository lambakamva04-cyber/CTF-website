// The busy times read from OMG's own calendar (src/calendar.js stores them),
// as the booking checks, the public calendar and the admin calendar read
// them. Kept apart from the sync code so those modules don't depend on it.

/** Her calendar's busy times: { 'YYYY-MM-DD': [[start, end], ...] } in minutes (SAST), or {} when none is connected. */
export async function externalBusy(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'calendar_busy'").first();
  if (!row) return {};
  try {
    const busy = JSON.parse(row.value);
    return busy && typeof busy === 'object' && !Array.isArray(busy) ? busy : {};
  } catch {
    return {};
  }
}

/** One date's busy minute ranges, checked, so a damaged entry can't block or free anything by accident. */
export function busyOn(busy, date) {
  const ranges = Object.prototype.hasOwnProperty.call(busy, date) ? busy[date] : null;
  if (!Array.isArray(ranges)) return [];
  return ranges.filter((r) => Array.isArray(r) && r.length === 2 && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 0 && r[1] <= 1440 && r[1] > r[0]);
}
