// Monthly minute usage and overage.
//
// Deliberately pure and free of D1: the rounding rule below is the part that
// decides what a client is charged, so it has to be testable without a
// database standing behind it. `tests/billing.test.ts` is the record of what
// the rule is.

/**
 * Billable minutes for a single call.
 *
 * Telephony bills per started minute, so every call rounds UP: a 5-second call
 * is one minute, 61 seconds is two. This is applied per call and only then
 * summed — rounding the monthly total instead would undercount by up to 59
 * seconds on every call, which across a few hundred calls is hours.
 *
 * A call with no duration bills nothing. `duration_s` is null while a call is
 * still up and on a missed call that never connected, and neither is airtime.
 */
export function billableMinutesForCall(durationSeconds: number | null | undefined): number {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds)) return 0;
  if (durationSeconds <= 0) return 0;
  return Math.ceil(durationSeconds / 60);
}

/** Sum of {@link billableMinutesForCall} across a month's calls. */
export function billableMinutes(durations: readonly (number | null | undefined)[]): number {
  let total = 0;
  for (const duration of durations) total += billableMinutesForCall(duration);
  return total;
}

/** The commercial terms this client signed, read from their organizations row. */
export interface PlanTerms {
  planMinutes: number;
  subscriptionZar: number;
  overageRateZar: number;
}

export interface BillingSummary {
  minutesUsed: number;
  planMinutes: number;
  extraMinutes: number;
  extraCostZar: number;
  subscriptionZar: number;
  overageRateZar: number;
}

/**
 * Usage against plan for one calendar month.
 *
 * `extraMinutes` has a floor of zero: a client who used 40 of 150 minutes is
 * 110 under, not owed R879 back. Unused minutes do not roll over and are not
 * refunded, so the only number worth showing is the overage.
 */
export function summariseBilling(minutesUsed: number, terms: PlanTerms): BillingSummary {
  const planMinutes = Math.max(0, terms.planMinutes);
  const extraMinutes = Math.max(0, minutesUsed - planMinutes);

  return {
    minutesUsed,
    planMinutes,
    extraMinutes,
    // Rounded to cents. Left as a plain number rather than a formatted string
    // so the SPA decides presentation, but rounded here so the two sides cannot
    // disagree about what the client owes.
    extraCostZar: Math.round(extraMinutes * terms.overageRateZar * 100) / 100,
    subscriptionZar: terms.subscriptionZar,
    overageRateZar: terms.overageRateZar,
  };
}
