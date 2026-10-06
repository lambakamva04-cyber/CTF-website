-- Applied to the Hope project on 6 October 2026 as migration
-- prospect_industry.
--
-- The demo was built for dental practices only: its page talks about patients,
-- and its Vapi assistant introduces itself as a dental practice's receptionist.
-- Law firms are the second kind of prospect. `industry` says which kind a row
-- is, so the page can use the right words and the right assistant (see
-- vapi/assistant-legal.md), and the outreach routine the right email.
--
-- Every existing row is a dental practice, so the default leaves them exactly
-- as they were.
alter table public.prospects
  add column if not exists industry text not null default 'dental';

alter table public.prospects drop constraint if exists prospects_industry_check;
alter table public.prospects add constraint prospects_industry_check
  check (industry in ('dental', 'legal'));
