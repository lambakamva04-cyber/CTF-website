-- Applied to the Hope project on 28 September 2026 as migration
-- 0009_least_privilege_and_backups.
--
-- Three changes from a security and reliability pass.
--
-- 1. Least privilege. `hope_bookings` still carried the default grants to
--    `anon` and `authenticated`: every privilege, including TRUNCATE, which
--    row level security does not govern. RLS with no policies already kept
--    the REST API out, and nothing uses those roles — the demo and the
--    heartbeat use the service role — so the grants go, as they did for the
--    other tables. The two trigger functions were executable by anyone as
--    well. Neither can be called as a function at all, so this changes
--    nothing but the advisor's report.
--
-- 2. Indexes. `demo_events_type_idx` is an exact duplicate of
--    `demo_events_type_recent_idx` and only slows inserts. The callback form's
--    flood limit counts one sender's requests in the last hour, which gets the
--    same partial index the public line's per-caller count already has.
--
-- 3. Backups. The project is on the free plan, which has no backups. Every
--    night each table is copied into the `backups` schema, and copies older
--    than seven days are dropped. That schema is not exposed through the API
--    and no client role holds any grant on it. This protects against deleted
--    or overwritten rows; it is not an off-site copy.

-- 1. Least privilege --------------------------------------------------------

revoke all on table public.hope_bookings from anon, authenticated;

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
revoke execute on function public.prospects_autoslug() from public, anon, authenticated;

-- 2. Indexes -----------------------------------------------------------------

drop index if exists public.demo_events_type_idx;

create index if not exists leads_ip_hash_recent_idx
  on public.leads (ip_hash, created_at desc)
  where ip_hash is not null;

-- 3. Backups -----------------------------------------------------------------

create schema if not exists backups;
revoke all on schema backups from public, anon, authenticated;

-- Copies each table to backups.<table>_<yyyymmdd> and drops copies older than
-- `keep_days`. Returns how many tables were copied. It lives in `backups`,
-- not `public`, so it is not reachable through the REST API at all. pg_cron
-- runs it as the owner, so it needs no security definer.
create or replace function backups.snapshot_tables(keep_days integer default 7)
returns integer
language plpgsql
set search_path = public
as $$
declare
  t text;
  stamp text := to_char(now() at time zone 'utc', 'YYYYMMDD');
  copied integer := 0;
  old record;
begin
  foreach t in array array['prospects', 'leads', 'demo_events', 'demo_limits', 'hope_bookings']
  loop
    execute format('drop table if exists backups.%I', t || '_' || stamp);
    execute format('create table backups.%I as table public.%I', t || '_' || stamp, t);
    copied := copied + 1;
  end loop;

  for old in
    select tablename
      from pg_tables
     where schemaname = 'backups'
       and tablename ~ '_[0-9]{8}$'
       and to_date(right(tablename, 8), 'YYYYMMDD') < (now() at time zone 'utc')::date - keep_days
  loop
    execute format('drop table backups.%I', old.tablename);
  end loop;

  return copied;
end;
$$;

revoke execute on function backups.snapshot_tables(integer) from public, anon, authenticated;

select cron.schedule('nightly-table-snapshots', '41 1 * * *', $$select backups.snapshot_tables(7)$$);
