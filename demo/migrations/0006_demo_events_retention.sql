-- Applied to the Hope project on 18 September 2026 as migration
-- 20260918235903 (demo_events_retention).
--
-- Recorded here from the database's own migration history: the change was
-- made directly in Supabase and never committed at the time.
--
-- The nightly schedule itself was created separately and is not part of the
-- migration. It exists in the live project as the pg_cron job
-- `prune-demo-identifiers`, equivalent to:
--
--   select cron.schedule(
--     'prune-demo-identifiers',
--     '17 2 * * *',
--     'select public.prune_demo_event_identifiers();'
--   );

create extension if not exists pg_cron with schema extensions;

-- ---------------------------------------------------------------------------
-- Retention.
--
-- The rate limiter only ever looks back 24 hours, so an ip_hash older than a
-- month serves no purpose at all. Keeping it would mean holding a per-caller
-- handle indefinitely for no reason, which is exactly what CTF tells visitors
-- it does not do.
--
-- The rest of the row stays: duration, ended_reason and timestamp are the
-- funnel, and none of them say anything about who called or what was said.
-- ---------------------------------------------------------------------------
create or replace function public.prune_demo_event_identifiers()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.demo_events
  set ip_hash = null,
      user_agent = null
  where created_at < now() - interval '30 days'
    and (ip_hash is not null or user_agent is not null);

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

comment on function public.prune_demo_event_identifiers is
  'Nightly: strips ip_hash and user_agent from demo_events older than 30 days. The limiter only looks back 24 hours, so nothing is lost.';
