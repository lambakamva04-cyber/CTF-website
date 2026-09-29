-- Applied to the Hope project on 29 September 2026 as migration
-- hope_callbacks_and_reply_watch.
--
-- 1. Hope returns website callback requests. The demo's background Worker
--    (demo/heartbeat) picks up new rows in `leads` every five minutes, inside
--    South African calling hours, and has Hope phone them through Vapi. These
--    columns are its state:
--
--      callback_status        pending → calling → completed | no_answer | failed | skipped
--      callback_attempts      calls placed so far (a missed call is retried once)
--      callback_next_at       not before this time (the retry an hour later)
--      callback_number        the number actually dialled, in E.164
--      callback_call_id       Vapi's call id, polled until the call ends
--      callback_attempted_at  when the latest call was placed
--      callback_ended_reason  Vapi's ended reason for the latest call
--      callback_summary       Vapi's summary of the conversation
--
--    Rows that already exist get no status, so nobody who wrote in before this
--    change is called out of the blue. Only rows inserted from now on start as
--    'pending'.
--
-- 2. The hourly reply watch sends one holding reply to a prospect who answers
--    a cold email with interest or a question. `auto_replied_at` records it, so
--    it is never sent twice.

alter table public.leads
  add column if not exists callback_status text,
  add column if not exists callback_attempts integer not null default 0,
  add column if not exists callback_next_at timestamptz,
  add column if not exists callback_number text,
  add column if not exists callback_call_id text,
  add column if not exists callback_attempted_at timestamptz,
  add column if not exists callback_ended_reason text,
  add column if not exists callback_summary text;

-- Set after the column exists, so existing rows stay null (not called).
alter table public.leads alter column callback_status set default 'pending';

alter table public.leads drop constraint if exists leads_callback_status_check;
alter table public.leads add constraint leads_callback_status_check
  check (callback_status is null
      or callback_status in ('pending', 'calling', 'completed', 'no_answer', 'failed', 'skipped'));

create index if not exists leads_callback_queue_idx
  on public.leads (callback_status, created_at)
  where callback_status in ('pending', 'calling');

alter table public.prospects
  add column if not exists auto_replied_at timestamptz;
