-- The dashboard's call statistics are cached for a minute (worker/lib/statsCache.ts).
--
-- stats_version goes up by one every time something changes a statistic: a new
-- call arrives, or a call ends with its outcome and length. The cache key
-- includes it, so after a change the next request works the numbers out afresh
-- instead of showing the old ones for up to a minute.
--
-- It has a default, and the code treats a missing column as "do not cache", so
-- code deployed before this migration keeps working against the old schema.
ALTER TABLE organizations ADD COLUMN stats_version INTEGER NOT NULL DEFAULT 0;
