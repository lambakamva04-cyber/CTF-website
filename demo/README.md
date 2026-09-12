# Hope demo pages

A cold email goes out to a dental practice with one link in it. The link opens
this page, the prospect taps one button, and thirty seconds later they are
talking to an AI receptionist that already knows their practice name, their
suburb, their services and their hours.

```
cold email ──▶ /demo/<slug> ──▶ [Talk to Hope] ──▶ Vapi assistant (browser mic)
                    │                  │                    │
             Supabase row        server routes         assistantOverrides
          (practice details)   (service role key)      (per-prospect values)
```

## The rule that governs everything here

**One route, one page component, one Vapi assistant.** Per-prospect variation
comes from a row in `prospects` and from `assistantOverrides.variableValues` at
call time. There is no per-client page, no per-client assistant and no
per-client deployment, and adding one is not a shortcut — it is forty prompts
that will drift apart by March. Adding a practice is an `INSERT`.

## Layout

| Path | What it is |
| --- | --- |
| `src/app/demo/[slug]/page.tsx` | The whole page, server-rendered from one Supabase row |
| `src/app/demo/[slug]/DemoPanel.tsx` | The button and every state after it: live, ended, expired, mic denied, failed |
| `src/app/api/demo/[slug]/route.ts` | `GET` — the prospect's display fields plus `expired` |
| `src/app/api/demo/[slug]/event/route.ts` | `POST` — writes a `demo_events` row; spends the link on `call_started` |
| `src/lib/prospects.ts` | Every Supabase query, server-only |
| `src/lib/demo.ts` | The bits both sides share: the 180-second cap, event names, slug rule |
| `migrations/0001_init.sql` | The two tables |
| `vapi/assistant.md` | **The system prompt.** The positioning lives here as much as in the page copy |
| `scripts/seed.mjs` | Adds a prospect |

## Security model

The browser never holds a Supabase credential and never queries Supabase.

One demo link leaking is a normal cost of cold email — a receptionist forwards
it, a competitor ends up with it. What that person must not be able to do is
read the `prospects` table and walk away with our entire prospecting list. So:

- RLS is enabled on both tables with **no policies at all**, and `anon` and
  `authenticated` hold no grants on them.
- Every read and write goes through a Next.js server route holding
  `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS.
- The server hands the page only the display fields. `id` and `demo_used_at`
  stay on the server; the browser learns a boolean, `expired`.
- `GET /api/demo/<unknown>` and `GET /api/demo/<malformed>` return the same
  404 body, so the endpoint cannot be used to test which links exist.
- The page sets `robots: noindex` and the app sends `X-Robots-Tag: noindex`, so
  a prospect's name never reaches a search index.

`src/lib/supabase.ts`, `src/lib/env.ts` and `src/lib/prospects.ts` all import
`server-only`, so an accidental import from a client component fails the build
rather than shipping the service role key to a browser.

## Spend control

Vapi bills per minute and this product has no revenue. Two caps, deliberately
redundant:

- **Three minutes per call.** The browser counts down and calls `vapi.stop()`
  at 180 seconds; the same number is sent to Vapi as `maxDurationSeconds`, so a
  tampered client cannot outrun it. Both come from `DEMO_MAX_SECONDS` in
  `src/lib/demo.ts`.
- **One call per link.** `demo_used_at` is stamped by a conditional update
  (`... where demo_used_at is null`), so two tabs racing produce one call. The
  link is spent when Hope actually answers — a failed connection or a refused
  microphone leaves it intact.

## Setup

Requires Node 22+.

```bash
cd demo
npm install
cp .env.example .env.local   # then fill it in
```

**1. Supabase.** Create a project, then run `migrations/0001_init.sql` in the
SQL editor (or `supabase db execute --file migrations/0001_init.sql`). Copy the
project URL and the `service_role` key from Settings → API into `.env.local`.

**2. Vapi.** Create one assistant, and configure it exactly as
[`vapi/assistant.md`](vapi/assistant.md) sets out — the system prompt there
carries the `{{practice_name}}`, `{{suburb}}`, `{{services}}` and `{{hours}}`
placeholders this app fills in at call time. Put the assistant id and your
public key in `.env.local`.

**3. Seed and run.**

```bash
npm run seed          # inserts the Rosebank Family Dental test prospect
npm run dev
open http://localhost:3000/demo/rosebank-family-dental
```

### Environment variables

| Name | Where it is used | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | Server | Settings → Data API |
| `SUPABASE_SERVICE_ROLE_KEY` | Server | Bypasses RLS. Never expose, never prefix with `NEXT_PUBLIC_` |
| `VAPI_PUBLIC_KEY` | Rendered to the browser | Vapi's public key is designed for this |
| `VAPI_ASSISTANT_ID` | Rendered to the browser | The single shared demo assistant |
| `BOOKING_URL` | Rendered to the browser | Where "Book a 15-minute call" points |
| `DEMO_BASE_URL` | `scripts/seed.mjs` only | Optional; makes the printed link use your real domain |

The two Vapi values are passed from the server component as props rather than
inlined as `NEXT_PUBLIC_*` at build time. Rotating a key or pointing at a
different assistant is then an environment change plus a redeploy, not a
rebuild.

## Adding a prospect

```bash
node scripts/seed.mjs \
  --slug rosebank-family-dental \
  --name "Rosebank Family Dental" \
  --suburb "Rosebank, Johannesburg" \
  --services "general dentistry,implants,orthodontics" \
  --hours "Mon–Fri 08:00–17:00, Sat 08:00–13:00"
```

It prints the link to paste into the email. Re-running with the same slug
updates the row, so a corrected practice name is one command, not a migration.

Choose slugs that a human can read in a URL bar —
`rosebank-family-dental`, not `a3f9c2`. The prospect should be able to tell at a
glance the link was written for them.

For your own testing, `--reset` clears `demo_used_at` and makes a spent link
live again:

```bash
node scripts/seed.mjs --slug rosebank-family-dental --reset
```

A prospect gets one conversation. Resetting a real prospect's link is a
decision about spend, not a convenience.

## Reading the numbers

Everything the page can do writes a row in `demo_events`. Run these in the
Supabase SQL editor.

**Click-to-talk — the number that decides whether the campaign works.**

```sql
select
  count(*) filter (where event_type = 'page_view')    as opened,
  count(*) filter (where event_type = 'call_started') as talked,
  round(
    100.0 * count(*) filter (where event_type = 'call_started')
    / nullif(count(*) filter (where event_type = 'page_view'), 0)
  , 1) as click_to_talk_pct
from demo_events
where created_at > now() - interval '7 days';
```

**Per prospect, in order of interest.** Anyone who talked to Hope for more than
sixty seconds is a call worth making.

```sql
select
  p.practice_name,
  p.slug,
  count(*) filter (where e.event_type = 'page_view')    as views,
  count(*) filter (where e.event_type = 'call_started') as calls,
  max(e.duration_seconds) filter (where e.event_type = 'call_ended') as longest_call_s,
  max(e.created_at) as last_seen
from prospects p
left join demo_events e on e.prospect_id = p.id
group by p.id
order by longest_call_s desc nulls last, views desc;
```

**Where it breaks.** A rising `mic_denied` share means the instructions on the
page are not working; a rising `link_expired` share means people are coming
back, which is a reason to follow up, not a bug.

```sql
select event_type, count(*)
from demo_events
where created_at > now() - interval '7 days'
group by event_type
order by count(*) desc;
```

**How calls end.** `demo-time-limit` means they were still talking when we cut
them off — the strongest buying signal on the page.

```sql
select ended_reason, count(*), round(avg(duration_seconds)) as avg_seconds
from demo_events
where event_type = 'call_ended'
group by ended_reason
order by count(*) desc;
```

## Deploying

Vercel, root directory `demo`. Set the five environment variables in the
project settings, then deploy.

> **Vercel's Hobby tier prohibits commercial use.** These pages go in front of
> paying prospects as part of a sales campaign, which is squarely commercial.
> Move the project onto **Pro** before the first cold email goes out — not
> after. Vercel enforce this by taking the deployment down, and a dead demo
> link in a cold email is a prospect you do not get a second attempt at.

## Positioning, which is not a copy question

Hope is an **overflow extension**. She catches the calls the front desk cannot
get to. She is never a replacement for reception staff, and nothing on this
page or in her mouth may imply staff reduction, headcount saving, or "always
available so you don't need someone".

This is commercial, not sentimental. The person who opens this link is very
often the receptionist herself, forwarding it to the practice owner. If the
page reads as a threat to her job, it never reaches him. Both the page copy and
the system prompt in [`vapi/assistant.md`](vapi/assistant.md) are written to
that constraint — check any change to either against it.
