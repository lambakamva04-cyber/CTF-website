-- Applied to the Hope project on 28 September 2026 as migration
-- 0010_backups_without_ip_hashes.
--
-- The privacy policy promises the hashed IP kept with public line calls and
-- callback requests is deleted after 30 days. A seven-day backup copy of a
-- 29-day-old row would keep it for up to 36. The hashes, and the browser
-- names beside them, only exist to count recent requests for the flood
-- limits, which is no use to a restore — so the nightly copies are taken
-- without them, and today's copies (taken by 0009) are cleared.

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

  -- Same columns as the live tables, so a copy still restores with
  -- `insert ... select *`; the flood-limit identifiers are simply empty.
  execute format('update backups.%I set ip_hash = null, user_agent = null', 'demo_events_' || stamp);
  execute format('update backups.%I set ip_hash = null, user_agent = null', 'leads_' || stamp);

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

select backups.snapshot_tables(7);
