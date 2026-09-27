-- Written 27 September 2026. Apply in the Supabase SQL editor, or as a
-- migration named lock_down_gate_and_prune_leads.
--
-- Two follow-ups to 0005 and 0006.
--
-- 1. Execute rights. Postgres grants EXECUTE on every new function to PUBLIC,
--    so both security-definer functions below could be called by anyone
--    holding the project's anon key, through the REST API. Neither does much
--    harm — one reports whether today's public line budget is spent, the
--    other runs the nightly clean-up early — but nothing outside the server
--    has any business calling them. The demo calls the gate with the service
--    role key, and pg_cron runs the clean-up as the owner; both keep access.
--
-- 2. Callback requests also carry an ip_hash, for the form's flood limit,
--    which looks back one hour. The nightly clean-up now strips it from leads
--    after 30 days as well, the same as from demo events.

create or replace function public.prune_demo_event_identifiers()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
  v_lead_rows integer;
begin
  update public.demo_events
  set ip_hash = null,
      user_agent = null
  where created_at < now() - interval '30 days'
    and (ip_hash is not null or user_agent is not null);

  get diagnostics v_rows = row_count;

  update public.leads
  set ip_hash = null
  where created_at < now() - interval '30 days'
    and ip_hash is not null;

  get diagnostics v_lead_rows = row_count;
  return v_rows + v_lead_rows;
end;
$$;

comment on function public.prune_demo_event_identifiers is
  'Nightly: strips ip_hash and user_agent from demo_events, and ip_hash from leads, older than 30 days. The limiters only look back 24 hours, so nothing is lost.';

revoke execute on function public.public_demo_gate(text) from public, anon, authenticated;
revoke execute on function public.prune_demo_event_identifiers() from public, anon, authenticated;

-- RLS already hides both tables from the browser roles; this removes the
-- grants too, as 0001 does for prospects and demo_events.
revoke all on public.leads from anon, authenticated;
revoke all on public.demo_limits from anon, authenticated;
