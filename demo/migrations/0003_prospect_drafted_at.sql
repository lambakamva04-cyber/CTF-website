-- Applied to the Hope project on 17 September 2026 as migration
-- 20260917164524 (add_prospect_drafted_at).
--
-- Recorded here from the database's own migration history: the change was
-- made directly in Supabase and never committed at the time.

alter table public.prospects
  add column if not exists drafted_at timestamptz;
