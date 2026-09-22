import { describe, expect, it } from 'vitest';
import { billableMinutes, billableMinutesForCall, summariseBilling } from '../worker/lib/billing';
import { startOfLocalMonth } from '../worker/lib/time';

const JHB = 'Africa/Johannesburg';

// The list price as of migration 0003. Every test states its own terms rather
// than importing a constant, so a change to the defaults cannot quietly change
// what these tests assert.
const LIST = { planMinutes: 150, subscriptionZar: 1499, overageRateZar: 7.99 };

describe('per-call rounding', () => {
  it('rounds a part-minute call up to a whole minute', () => {
    expect(billableMinutesForCall(5)).toBe(1);
    expect(billableMinutesForCall(59)).toBe(1);
    expect(billableMinutesForCall(60)).toBe(1);
    expect(billableMinutesForCall(61)).toBe(2);
    expect(billableMinutesForCall(120)).toBe(2);
    expect(billableMinutesForCall(121)).toBe(3);
  });

  it('bills nothing for a call that never carried audio', () => {
    // null while a call is still up, and on a missed call that never connected.
    expect(billableMinutesForCall(null)).toBe(0);
    expect(billableMinutesForCall(undefined)).toBe(0);
    expect(billableMinutesForCall(0)).toBe(0);
  });

  it('ignores impossible durations rather than billing them', () => {
    expect(billableMinutesForCall(-30)).toBe(0);
    expect(billableMinutesForCall(Number.NaN)).toBe(0);
    expect(billableMinutesForCall(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('rounding is per call, not on the total', () => {
  it('bills three short calls as three minutes, not one', () => {
    // 10 + 10 + 10 = 30 seconds. Flooring or rounding the total gives 0 or 1
    // minute; the client is charged for three started minutes.
    expect(billableMinutes([10, 10, 10])).toBe(3);
  });

  it('does not lose the remainder on each call', () => {
    // 90s + 90s is three started minutes, not the 3 you get from ceil(180/60)
    // by luck — 61 + 61 proves the difference: 4 per call vs 3 on the total.
    expect(billableMinutes([61, 61])).toBe(4);
    expect(Math.ceil((61 + 61) / 60)).toBe(3); // the wrong answer, for contrast
  });

  it('sums a realistic month, skipping calls with no duration', () => {
    // 45s, 3m01s, missed, 2m00s, still ringing → 1 + 4 + 0 + 2 + 0
    expect(billableMinutes([45, 181, null, 120, undefined])).toBe(7);
  });

  it('is zero for a month with no calls', () => {
    expect(billableMinutes([])).toBe(0);
  });
});

describe('usage against plan', () => {
  it('charges nothing while under the plan', () => {
    const summary = summariseBilling(40, LIST);
    expect(summary.extraMinutes).toBe(0);
    expect(summary.extraCostZar).toBe(0);
    expect(summary.minutesUsed).toBe(40);
    expect(summary.planMinutes).toBe(150);
  });

  it('floors extra minutes at zero — unused minutes are not a credit', () => {
    // 110 minutes under plan must never surface as -110 minutes or -R878.90.
    const summary = summariseBilling(40, LIST);
    expect(summary.extraMinutes).toBeGreaterThanOrEqual(0);
    expect(summary.extraCostZar).toBeGreaterThanOrEqual(0);
  });

  it('charges nothing at exactly the plan limit', () => {
    const summary = summariseBilling(150, LIST);
    expect(summary.extraMinutes).toBe(0);
    expect(summary.extraCostZar).toBe(0);
  });

  it('charges the first minute over', () => {
    const summary = summariseBilling(151, LIST);
    expect(summary.extraMinutes).toBe(1);
    expect(summary.extraCostZar).toBe(7.99);
  });

  it('charges the overage rate per extra minute', () => {
    const summary = summariseBilling(200, LIST);
    expect(summary.extraMinutes).toBe(50);
    expect(summary.extraCostZar).toBe(399.5);
  });

  it('rounds rand to cents rather than leaking float noise', () => {
    // 3 * 7.99 is 23.970000000000002 in IEEE 754. A client must never see that.
    const summary = summariseBilling(153, LIST);
    expect(summary.extraCostZar).toBe(23.97);
  });

  it('uses the org’s own terms, not the list price', () => {
    // A client who signed 300 minutes at R5.50 is billed on what they signed.
    const summary = summariseBilling(350, {
      planMinutes: 300,
      subscriptionZar: 2499,
      overageRateZar: 5.5,
    });
    expect(summary.extraMinutes).toBe(50);
    expect(summary.extraCostZar).toBe(275);
    expect(summary.subscriptionZar).toBe(2499);
  });

  it('treats a nonsensical negative plan as zero included minutes', () => {
    const summary = summariseBilling(10, { ...LIST, planMinutes: -150 });
    expect(summary.planMinutes).toBe(0);
    expect(summary.extraMinutes).toBe(10);
  });
});

describe('the month boundary billing is measured from', () => {
  it('starts at local midnight on the 1st, not UTC midnight', () => {
    // Johannesburg is UTC+2, so September starts at 22:00 UTC on 31 August.
    const at = new Date('2026-09-22T09:00:00Z');
    expect(new Date(startOfLocalMonth(at, JHB)).toISOString()).toBe('2026-08-31T22:00:00.000Z');
  });

  it('puts a call just after local month-start inside the month', () => {
    const at = new Date('2026-09-22T09:00:00Z');
    const monthStart = startOfLocalMonth(at, JHB);
    // 00:30 on 1 September in Johannesburg is 22:30 UTC on 31 August.
    const firstCall = new Date('2026-08-31T22:30:00Z').getTime();
    expect(firstCall).toBeGreaterThanOrEqual(monthStart);
  });

  it('excludes a call from the last minutes of the previous month', () => {
    const at = new Date('2026-09-22T09:00:00Z');
    const monthStart = startOfLocalMonth(at, JHB);
    // 23:30 on 31 August in Johannesburg is 21:30 UTC — still August.
    const lateAugustCall = new Date('2026-08-31T21:30:00Z').getTime();
    expect(lateAugustCall).toBeLessThan(monthStart);
  });

  it('rolls over on the 1st: a new month starts from zero', () => {
    const august = startOfLocalMonth(new Date('2026-08-15T09:00:00Z'), JHB);
    const september = startOfLocalMonth(new Date('2026-09-01T09:00:00Z'), JHB);
    expect(september).toBeGreaterThan(august);
    // A mid-August call is outside September's window, so September's usage
    // does not inherit August's minutes.
    const augustCall = new Date('2026-08-15T09:00:00Z').getTime();
    expect(augustCall).toBeLessThan(september);
  });
});
