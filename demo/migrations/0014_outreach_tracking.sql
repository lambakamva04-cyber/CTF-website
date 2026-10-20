-- Outreach tracking — the founder's manual cold-outreach cadence, and the
-- unsubscribe/suppression list behind it.
--
-- 0001 records what a prospect does once they hold a demo link. This records
-- what the founder does to get them there: the LinkedIn connect, the DM with
-- the link, the cold email, the follow-ups, and whether any of it landed. It
-- is the data behind the internal admin analytics dashboard, and the real
-- opt-out list the unsubscribe route writes to.
--
-- Same one security rule as 0001: row level security on with no policies, so
-- the anon and authenticated roles read nothing. Every read and write goes
-- through a Next.js server route holding the service role key, which bypasses
-- RLS. An outreach row holds a contact's name, email and LinkedIn profile —
-- exactly the kind of list a competitor forwarded one link must never walk.
--
-- Not yet applied. Apply with:
--   supabase db execute --file migrations/0014_outreach_tracking.sql
-- or paste into the Supabase SQL editor.

-- ---------------------------------------------------------------------------
-- One row per prospect + contact the founder is working by hand. It is its own
-- table rather than more columns on `prospects` for two reasons: a prospect can
-- have more than one contact (a practice manager and an owner), and `prospects`
-- already carries a single contact (0002) for the automated cold-email routine.
-- This is the manual, multi-touch cadence that sits alongside that.
-- ---------------------------------------------------------------------------
create table if not exists public.outreach (
  id              uuid primary key default gen_random_uuid(),
  prospect_id     uuid not null references public.prospects (id) on delete cascade,

  -- Who, on the prospect's side, this cadence is aimed at.
  contact_name    text,
  contact_email   text,
  linkedin_url    text,

  -- How the founder is reaching this contact: 'linkedin', 'email',
  -- 'linkedin+email'. Free text, not a check constraint, because the cadence
  -- changes faster than a constraint should.
  channel         text,

  -- The cadence, one timestamp per step, so the dashboard can show how far each
  -- contact has moved. Null means the step has not happened. followups_sent is
  -- a count because the two follow-ups (nudge, break-up) are otherwise
  -- indistinguishable on the dashboard.
  connect_sent_at timestamptz,
  dm_sent_at      timestamptz,
  email_sent_at   timestamptz,
  followups_sent  int not null default 0 check (followups_sent >= 0),

  -- Where it landed. responded_at is any reply at all; interested is the
  -- founder's own judgement that the reply is worth pursuing, stamped at
  -- interested_at. opted_out_at is set by the unsubscribe route (the email also
  -- goes on email_suppression below) so an opted-out contact is never shown as
  -- still in the cadence. booked_at is a call on the calendar.
  responded_at    timestamptz,
  interested      boolean not null default false,
  interested_at   timestamptz,
  opted_out_at    timestamptz,
  booked_at       timestamptz,

  notes           text,
  updated_at      timestamptz not null default now()
);

-- One cadence per prospect + contact, so the importer can upsert a corrected
-- row instead of inserting a duplicate. coalesce(contact_email, '') folds the
-- contacts with no email into a single key: without it two null-email rows for
-- the same prospect would not collide (NULL is distinct from NULL in a unique
-- index), and a re-run would keep inserting them. This index also serves the
-- dashboard's lookups by prospect_id, so no separate index is added for those.
create unique index if not exists outreach_prospect_contact_key
  on public.outreach (prospect_id, coalesce(contact_email, ''));

-- The unsubscribe route finds a contact by their lowercased email, so the
-- opt-out match has an index that is folded the same way the route normalises
-- the address before it compares.
create index if not exists outreach_contact_email_idx
  on public.outreach (lower(contact_email))
  where contact_email is not null;

-- ---------------------------------------------------------------------------
-- The real opt-out list. A recipient who clicks "unsubscribe" lands here, and
-- it is the one place the outreach routine must check before emailing anyone
-- again. It is kept separate from `outreach` on purpose: a suppression has to
-- outlive any single cadence row — a contact can opt out before they are ever
-- imported, or after their prospect is deleted — so it is keyed by email alone.
-- ---------------------------------------------------------------------------
create table if not exists public.email_suppression (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  -- Why they are suppressed: 'unsubscribe' from the link, or a 'bounce',
  -- 'complaint' or manual note later. Free text, like `channel` above.
  reason       text,
  -- Where it came from: the unsubscribe route sets 'unsubscribe_link'.
  source       text,
  created_at   timestamptz not null default now()
);

-- Case-insensitive uniqueness without the citext extension: the address is
-- matched on its lowercase form, so "Sam@x.com" and "sam@x.com" are one entry
-- and the unsubscribe upsert is idempotent.
create unique index if not exists email_suppression_email_key
  on public.email_suppression (lower(email));

-- RLS on, no policies: nothing but the service role gets through.
alter table public.outreach          enable row level security;
alter table public.email_suppression enable row level security;

-- Belt and braces, as 0001 does for prospects and demo_events: even if a policy
-- is added by accident later, the browser roles hold no table grants to use it.
revoke all on public.outreach          from anon, authenticated;
revoke all on public.email_suppression from anon, authenticated;
