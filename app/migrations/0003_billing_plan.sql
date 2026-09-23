-- What each client actually signed, so overage can be charged from their own
-- terms rather than from a price list that has since moved on.
--
-- The list price today is R1,999 once-off setup, then R1,499 a month including
-- 150 minutes, with R7.99 a minute beyond that. Those are the column defaults.
--
-- READ THIS BEFORE APPLYING TO PRODUCTION. `ADD COLUMN ... NOT NULL DEFAULT`
-- backfills EVERY existing row, not just rows created from here on. Every org
-- already in the table lands on the list price the moment this runs, whether or
-- not that is what they signed. Any client on different terms must be corrected
-- immediately afterwards:
--
--   UPDATE organizations
--      SET plan_minutes = ?, subscription_zar = ?, overage_rate_zar = ?
--    WHERE slug = ?;
--
-- After that the columns are per-org and stay that way: a later change to the
-- list price is a change to this file's defaults and touches nobody existing.
--
-- Money is REAL because these are rand amounts entered by a human, never
-- accumulated balances. Nothing in this schema sums currency across rows, so
-- there is no place for floating-point error to compound; the one derived
-- figure, monthly overage, is computed per request from whole minutes.

-- Minutes included in the monthly subscription before overage starts.
ALTER TABLE organizations ADD COLUMN plan_minutes INTEGER NOT NULL DEFAULT 150;

-- Recurring monthly fee in rand, excluding overage.
ALTER TABLE organizations ADD COLUMN subscription_zar REAL NOT NULL DEFAULT 1499.00;

-- Rand per minute once plan_minutes is exhausted.
ALTER TABLE organizations ADD COLUMN overage_rate_zar REAL NOT NULL DEFAULT 7.99;

-- Once-off onboarding fee in rand. Recorded here so a client's commercial terms
-- live in one place, even though nothing recurring reads it.
ALTER TABLE organizations ADD COLUMN setup_fee_zar REAL NOT NULL DEFAULT 1999.00;
