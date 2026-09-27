-- Applied to the Hope project on 17 September 2026 as migration
-- 20260917180734 (add_prospect_is_test_flag).
--
-- Recorded here from the database's own migration history: the change was
-- made directly in Supabase and never committed at the time.

alter table public.prospects
  add column if not exists is_test boolean not null default false;

comment on column public.prospects.is_test is
  'Internal CTF test rows. Never spent by claimDemo, never shown as expired, and excluded from outreach drafting.';
