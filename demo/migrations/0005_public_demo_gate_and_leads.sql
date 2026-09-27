-- Applied to the Hope project on 18 September 2026 as migration
-- 20260918153038 (public_demo_gate_and_leads).
--
-- Recorded here from the database's own migration history: the change was
-- made directly in Supabase and never committed at the time. The live
-- `demo_limits` row has since been set to global_per_day = 15.

-- ---------------------------------------------------------------------------
-- Public demo: one always-on line on the marketing site, rate limited so a
-- curious crowd cannot drain the Vapi balance the real prospects depend on.
-- ---------------------------------------------------------------------------

alter table public.prospects
  add column if not exists is_public boolean not null default false;

comment on column public.prospects.is_public is
  'The public "try it now" line on the marketing site. Never spent, never drafted, but rate limited by public_demo_gate().';

-- IPs are never stored. Only a salted SHA-256 digest, so a caller can be
-- counted without CTF holding an identifier for them.
alter table public.demo_events
  add column if not exists ip_hash text;

create index if not exists demo_events_ip_hash_recent_idx
  on public.demo_events (ip_hash, created_at desc)
  where ip_hash is not null;

create index if not exists demo_events_type_recent_idx
  on public.demo_events (event_type, created_at desc);

-- Tunables live in one row so limits can be changed without a deploy.
create table if not exists public.demo_limits (
  id                smallint primary key default 1 check (id = 1),
  max_seconds       integer not null default 60,
  per_ip_per_hour   integer not null default 3,
  global_per_day    integer not null default 40,
  updated_at        timestamptz not null default now()
);

insert into public.demo_limits (id) values (1) on conflict (id) do nothing;

alter table public.demo_limits enable row level security;

-- ---------------------------------------------------------------------------
-- The gate. Two independent limits, checked together:
--
--   per-IP    generous, so a practice where two people try it is fine. It
--             exists to stop one person hammering the line, not to ration
--             a shared office or a mobile network behind CGNAT.
--   global    the actual budget protection, and the answer to shared IPs:
--             even if every caller looked identical, the day's spend is
--             capped. Nobody is blocked because of who came before them
--             unless the whole day's budget is gone.
-- ---------------------------------------------------------------------------
create or replace function public.public_demo_gate(p_ip_hash text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limits      public.demo_limits%rowtype;
  v_ip_count    integer;
  v_day_count   integer;
begin
  select * into v_limits from public.demo_limits where id = 1;

  select count(*) into v_day_count
  from public.demo_events e
  join public.prospects p on p.id = e.prospect_id
  where p.is_public
    and e.event_type = 'call_started'
    and e.created_at > now() - interval '24 hours';

  if v_day_count >= v_limits.global_per_day then
    return json_build_object(
      'allowed', false,
      'reason', 'daily_cap',
      'max_seconds', v_limits.max_seconds
    );
  end if;

  if p_ip_hash is not null then
    select count(*) into v_ip_count
    from public.demo_events e
    join public.prospects p on p.id = e.prospect_id
    where p.is_public
      and e.event_type = 'call_started'
      and e.ip_hash = p_ip_hash
      and e.created_at > now() - interval '1 hour';

    if v_ip_count >= v_limits.per_ip_per_hour then
      return json_build_object(
        'allowed', false,
        'reason', 'ip_cooldown',
        'max_seconds', v_limits.max_seconds
      );
    end if;
  end if;

  return json_build_object(
    'allowed', true,
    'reason', 'ok',
    'max_seconds', v_limits.max_seconds
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Callback requests from the marketing site.
-- ---------------------------------------------------------------------------
create table if not exists public.leads (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  business_type text,
  phone         text,
  message       text,
  source        text not null default 'website',
  ip_hash       text,
  user_agent    text,
  created_at    timestamptz not null default now(),
  contacted_at  timestamptz
);

alter table public.leads enable row level security;

create index if not exists leads_created_idx on public.leads (created_at desc);
