import { describe, expect, it } from 'vitest';
import {
  isValidTimeZone,
  startOfLocalDay,
  startOfLocalMonth,
  startOfLocalWeek,
} from '../worker/lib/time';

const JHB = 'Africa/Johannesburg'; // UTC+2 year round, no DST
const NYC = 'America/New_York'; // UTC-5 / UTC-4 with DST

describe('local day boundaries', () => {
  it('anchors "today" to the client timezone, not UTC', () => {
    // 00:30 UTC on 15 May is already 02:30 the same day in Johannesburg, so
    // the day started at 22:00 UTC on the 14th.
    const at = new Date('2026-05-15T00:30:00Z');
    expect(new Date(startOfLocalDay(at, JHB)).toISOString()).toBe('2026-05-14T22:00:00.000Z');
  });

  it('puts a late-evening UTC instant in the correct local day', () => {
    // 23:00 UTC on 14 May is 01:00 on the 15th in Johannesburg.
    const at = new Date('2026-05-14T23:00:00Z');
    expect(new Date(startOfLocalDay(at, JHB)).toISOString()).toBe('2026-05-14T22:00:00.000Z');
  });

  it('walks backwards by whole local days', () => {
    const at = new Date('2026-05-15T12:00:00Z');
    const today = startOfLocalDay(at, JHB);
    const yesterday = startOfLocalDay(at, JHB, -1);
    expect(today - yesterday).toBe(86_400_000);
  });

  it('handles a timezone that observes daylight saving', () => {
    const summer = startOfLocalDay(new Date('2026-07-15T12:00:00Z'), NYC);
    const winter = startOfLocalDay(new Date('2026-01-15T12:00:00Z'), NYC);
    expect(new Date(summer).toISOString()).toBe('2026-07-15T04:00:00.000Z'); // EDT, UTC-4
    expect(new Date(winter).toISOString()).toBe('2026-01-15T05:00:00.000Z'); // EST, UTC-5
  });
});

describe('week and month boundaries', () => {
  it('starts the week on Monday', () => {
    // 15 May 2026 is a Friday; the week began on Monday the 11th.
    const at = new Date('2026-05-15T12:00:00Z');
    expect(new Date(startOfLocalWeek(at, JHB)).toISOString()).toBe('2026-05-10T22:00:00.000Z');
  });

  it('treats Monday itself as the start of its own week', () => {
    const monday = new Date('2026-05-11T08:00:00Z');
    expect(startOfLocalWeek(monday, JHB)).toBe(startOfLocalDay(monday, JHB));
  });

  it('treats Sunday as the end of the week, not the start', () => {
    const sunday = new Date('2026-05-17T08:00:00Z');
    expect(new Date(startOfLocalWeek(sunday, JHB)).toISOString()).toBe('2026-05-10T22:00:00.000Z');
  });

  it('starts the month on the first local day', () => {
    const at = new Date('2026-05-15T12:00:00Z');
    expect(new Date(startOfLocalMonth(at, JHB)).toISOString()).toBe('2026-04-30T22:00:00.000Z');
  });
});

describe('timezone validation', () => {
  it('accepts real zones and rejects junk, so a bad org row cannot 500', () => {
    expect(isValidTimeZone(JHB)).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
