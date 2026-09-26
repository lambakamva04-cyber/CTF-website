-- Hope demo pages — schema.
--
-- Two tables, one security rule: the browser never touches either of them.
-- Row level security is enabled with no policies at all, so the anon key can
-- read nothing. Every read and write goes through a Next.js server route
-- holding the service role key, which bypasses RLS. A competitor who is
-- forwarded one cold-email link therefore cannot walk the prospect list.
--
-- Apply with:
--   supabase db execute --file migrations/0001_init.sql
-- or paste into the Supabase SQL editor.

create extension if not exists pgcrypto;

-- One row per prospect we have emailed. The slug is the whole link:
-- https://demo.cutthroughfaster.com/demo/<slug>
create table if not exists public.prospects (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  practice_name text not null,
  suburb        text,
  -- e.g. {"general dentistry","implants","orthodontics"} — read out to Hope as
  -- the services she is allowed to talk about.
  services      text[],
  -- Free text, kept human: "Mon–Fri 08:00–17:00, Sat 08:00–13:00".
  hours         text,
  -- Stamped the first time a call starts. Non-null means the link is spent.
  -- One live conversation per prospect, because Vapi bills by the minute.
  demo_used_at  timestamptz,
  created_at    timestamptz not null default now(),

  -- Slugs go in URLs and in emails. Keep them boring and lowercase; the API
  -- applies the same rule before it ever reaches the database.
  constraint prospects_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$')
);

-- Every observable moment of the demo. This is the only funnel we have while
-- the cold campaign is running, so it is written on the server for every
-- state the page can reach — including the ones that mean failure.
create table if not exists public.demo_events (
  id               uuid primary key default gen_random_uuid(),
  prospect_id      uuid not null references public.prospects (id) on delete cascade,
  event_type       text not null check (
                     event_type in (
                       'page_view',
                       'call_started',
                       'call_ended',
                       'mic_denied',
                       'link_expired'
                     )
                   ),
  -- Set on call_ended only.
  duration_seconds int check (duration_seconds is null or duration_seconds >= 0),
  -- Set on call_ended only: who hung up, or why we did.
  ended_reason     text,
  user_agent       text,
  created_at       timestamptz not null default now()
);

create index if not exists demo_events_prospect_idx
  on public.demo_events (prospect_id, created_at desc);
create index if not exists demo_events_type_idx
  on public.demo_events (event_type, created_at desc);

-- RLS on, no policies. Nothing but the service role gets through.
alter table public.prospects   enable row level security;
alter table public.demo_events enable row level security;

-- Belt and braces: even if a policy is added by accident later, the browser
-- roles hold no table grants to exercise it.
revoke all on public.prospects   from anon, authenticated;
revoke all on public.demo_events from anon, authenticated;
