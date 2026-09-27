-- Applied to the Hope project on 17 September 2026 as migration
-- 20260917152319 (add_prospect_contact_and_outreach_fields).
--
-- Recorded here from the database's own migration history: the change was
-- made directly in Supabase and never committed at the time.

alter table public.prospects
  add column if not exists contact_email text,
  add column if not exists contact_name  text,
  add column if not exists phone         text,
  add column if not exists tier          text,
  add column if not exists source_url    text,
  add column if not exists email_sent_at timestamptz,
  add column if not exists replied_at    timestamptz,
  add column if not exists notes         text;

create unique index if not exists prospects_contact_email_key
  on public.prospects (lower(contact_email))
  where contact_email is not null;
