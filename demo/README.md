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
| `src/app/api/demo/[slug]/event/route.ts` | `POST` — writes a `demo_events` row; spends a personal link on `call_started` |
| `src/app/api/demo/[slug]/gate/route.ts` | `POST` — asked before every call on the public line; answers yes with the call length, or no with the reason |
| `src/app/api/lead/route.ts` | `POST` — callback requests from the marketing site's contact form, saved to `leads` |
| `src/lib/prospects.ts` | Every prospect, event and gate query, server-only |
| `src/lib/leads.ts` | Saving callback requests and their flood limit |
| `src/lib/caller.ts` | The salted hash of a caller's IP — all the limits ever store |
| `src/lib/demo.ts` | The bits both sides share: the 180-second cap, event names, slug rule |
| `migrations/` | Every change to the database, in order. 0002–0007 were made directly in Supabase and recorded here afterwards |
| `vapi/assistant.md` | **The system prompt.** The positioning lives here as much as in the page copy |
| `scripts/seed.mjs` | Adds a prospect |
| `wrangler.jsonc`, `open-next.config.ts` | Cloudflare Worker build and deploy |
| `heartbeat/` | Daily keep-alive so the free Supabase project never pauses, and Hope's callbacks to the website's leads |

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

Floods are refused at Cloudflare's edge, before any database work, by three
rate limiting bindings declared in `wrangler.jsonc` and checked in
`src/lib/limits.ts`, each counted per visitor on the hashed IP:

| Limiter | Covers | Per minute |
| --- | --- | --- |
| `DEMO_READ_LIMITER` | demo page loads, `GET /api/demo/<slug>`, the public line's gate | 30 |
| `DEMO_EVENT_LIMITER` | `POST /api/demo/<slug>/event` | 30 |
| `LEAD_FORM_LIMITER` | `POST /api/lead` | 5 |

A visitor over the page limit gets the ordinary not-found page. These sit in
front of the database limits below, not instead of them. Request bodies are
capped (`src/lib/body.ts`: 4 KB for an event, 16 KB for a callback request),
and every Supabase request is abandoned after 8 seconds (`src/lib/supabase.ts`)
rather than left to hang.

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

### The public line

`/demo/try` is the "Phone Hope now" button on the marketing site: a prospect
row with `is_public = true`, answering for a made-up sample practice. It is
never spent. Instead, before every call the page asks
`POST /api/demo/try/gate`, which runs `public_demo_gate()` in the database
against two limits held in the one-row `demo_limits` table:

- calls per person per hour (`per_ip_per_hour`), counted on a salted hash of
  the caller's IP — never the address itself;
- calls per day across everyone (`global_per_day`) — the real budget cap.

The same row sets the call length (`max_seconds`, one minute). All three can
be changed in the Supabase table editor without a deploy. A nightly pg_cron
job, `prune-demo-identifiers`, strips the IP hashes after 30 days.

The Vapi public key is in the page by design, so a browser that skips the gate
can still start a call; the gate keeps an ordinary crowd within budget, it is
not a lock. Rows with `is_test = true` (CTF's own test links) are never spent
either, and have no gate.

## Callback requests

The contact form on www.cutthroughfaster.com posts JSON to
`https://demo.cutthroughfaster.com/api/lead`. The route accepts only JSON from
the marketing site's origin, drops anything that fills in the hidden
`company_website` field, limits each sender to five requests an hour and
everyone to 200 a day, and saves the rest to `leads`. The same phone number
again within ten minutes (a double click, a retry) is answered as sent without
being saved or emailed twice.

Each saved request is then emailed to `LEAD_NOTIFY_TO` through Resend
(`EMAIL_API_KEY`), the provider the dashboard uses. A failed email does not
fail the form — the request is already saved — so it is only logged. Every
request is also in Supabase → Table Editor → `leads`, newest first; set
`contacted_at` once you have called back.

## Backups

The project is on Supabase's free plan, which keeps no backups. Every night at
01:41 UTC the pg_cron job `nightly-table-snapshots` copies each table into the
`backups` schema as `<table>_<yyyymmdd>` and drops copies older than seven days
(`backups.snapshot_tables()`, migrations 0009 and 0010). The copies leave out
the hashed IPs and user agents, which only serve the flood limits, so the
privacy policy's 30-day deletion holds for backups too. The schema is not
exposed through the API and no client role can read it. It covers deleted or
overwritten rows, not the loss of the project itself.

To put a table back, in the SQL editor, e.g. for leads from 28 September:

```sql
begin;
delete from public.leads;
insert into public.leads select * from backups.leads_20260928;
commit;
```

## Setup

Requires Node 22+.

```bash
cd demo
npm install
cp .env.example .env.local   # then fill it in
```

**1. Supabase.** Create a project, then run every file in `migrations/` in the
SQL editor, in order (or `supabase db execute --file ...` for each). Copy the
project URL and the `service_role` key from Settings → API into `.env.local`.

Change the database only by adding a new numbered file here and applying it.
A change made straight in Supabase and never committed is how the public line
and the callback form went missing from this code once already.

**2. Vapi.** Create one assistant, and configure it exactly as
[`vapi/assistant.md`](vapi/assistant.md) sets out — the system prompt there
carries the `{{practice_name}}`, `{{suburb}}`, `{{services}}` and `{{hours}}`
placeholders this app fills in at call time. Put the assistant id and your
public key in `.env.local`.

**3. Seed and run.**

```bash
npm run seed          # inserts the Rosebank Family Dental test prospect
npm run dev           # Next dev server, reads .env.local
open http://localhost:3000/demo/rosebank-family-dental
```

To exercise the actual Worker rather than the Next dev server — which is what
you want before any deploy, because the two are different runtimes:

```bash
cp .env.local .dev.vars   # wrangler reads .dev.vars, next reads .env.local
npm run preview           # builds with OpenNext, serves under wrangler
```

### Environment variables

| Name | Where it is used | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | Server | Settings → Data API |
| `SUPABASE_SERVICE_ROLE_KEY` | Server | Bypasses RLS. Never expose, never prefix with `NEXT_PUBLIC_` |
| `VAPI_PUBLIC_KEY` | Rendered to the browser | Vapi's public key is designed for this |
| `VAPI_ASSISTANT_ID` | Rendered to the browser | The shared demo assistant for dental practices ([`vapi/assistant.md`](vapi/assistant.md)) |
| `VAPI_HOPE_ASSISTANT_ID` | Rendered to the browser | Optional. Hope, the one assistant for every industry ([`vapi/hope-prompt.md`](vapi/hope-prompt.md)). Until it is set, a law firm's link is a 404 and the public line has no industry picker |
| `BOOKING_URL` | Rendered to the browser | Where "Book a 15-minute call" points |
| `DEMO_IP_SALT` | Server | Any long random string. Salts the IP hash; without it the per-person limits are skipped and only the daily caps apply |
| `EMAIL_API_KEY` | Server | Resend API key. Without it callback requests are saved but not emailed |
| `LEAD_NOTIFY_TO` | Server | Inbox for callback emails. Defaults to hello@cutthroughfaster.com |
| `EMAIL_FROM` | Server | Optional sender, on a domain verified with Resend. Defaults to `website@mail.cutthroughfaster.com` |
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

### Links for real prospects

A link that can be worked out from a practice's name can be opened, or its one
call spent, by anyone who tries. So for a real prospect, leave the slug to the
database: add a row in Supabase → Table Editor → `prospects` with just
`practice_name` (and `contact_email`), and the `prospects_autoslug` trigger
(migration 0011) writes a slug like `rosebank-family-dental-3f9c2a1e` — the
name, so it still reads as written for them, plus eight random characters.
The link is `https://demo.cutthroughfaster.com/demo/<slug>`; **copy the slug
from the new row**, do not type it from the name. Links made before that change
keep their old, name-only slugs, so they are not broken.

`--slug` (above) uses exactly the slug it is given, so keep it for CTF's own
test rows and for re-arming a link, not for real prospects.

### Law firms

Set `industry` to `legal` on the row (migration 0013; it defaults to `dental`).
The page then talks about clients and practice areas instead of patients and
services, and the call goes to Hope (`VAPI_HOPE_ASSISTANT_ID`,
[`vapi/hope-prompt.md`](vapi/hope-prompt.md)), told it is a law firm, never to
the dental assistant. Put the firm's practice areas in `services`. Until Hope is
set, a law firm's link is a 404.

On the public line, `/demo/try`, Hope also lets the visitor pick dental, law
firm, mechanic or salon, and answers for a sample business of that kind
(`SAMPLE_BUSINESSES` in `src/lib/demo.ts`). Personal links have no picker.

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

Cloudflare Workers, on the free tier, at `demo.cutthroughfaster.com`.

Not Vercel. Vercel's Hobby tier prohibits commercial use, and a sales campaign
is squarely commercial — which would have forced Pro, a recurring cost that a
company at zero revenue cannot justify. Cloudflare's free tier permits
commercial use and the domain is already a zone in the account.

### Why OpenNext and not next-on-pages

`@cloudflare/next-on-pages` is **deprecated** — npm serves a deprecation notice
pointing at OpenNext — and its peer range caps Next at `<=15.5.2`. This app is
on Next 16, so it cannot build it at all. There was no trade-off to weigh.

`@opennextjs/cloudflare` also turns out to be the better fit on its own merits:
it builds a **Worker** rather than a Pages project, and Workers support cron
triggers, which is where the Supabase keep-alive below has to live. It runs on
`nodejs_compat` rather than demanding `export const runtime = 'edge'` on every
route, so the Supabase client and the server routes work unchanged.

One consequence worth being explicit about: this is a Worker, not a Pages
project. It is a **new** Worker named `ctf-demo`, unrelated to the `ctf-website`
and `throbbing-disk-fd8d` builds already wired to the marketing site. Deploying
it does not touch either of them.

### First deploy

```bash
cd demo
npm install
npx wrangler login          # or export CLOUDFLARE_API_TOKEN=...

npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put VAPI_PUBLIC_KEY
npx wrangler secret put VAPI_ASSISTANT_ID
npx wrangler secret put BOOKING_URL

npm run deploy              # opennextjs-cloudflare build && wrangler deploy
```

The `[[routes]]` entry in `wrangler.jsonc` creates the DNS record and
certificate for `demo.cutthroughfaster.com` on deploy, because the zone is
already in this Cloudflare account. If the deploy fails naming the zone, drop
that block and use the `workers.dev` URL until DNS is sorted — but do not send
a cold email pointing at a `workers.dev` address. It reads as a phishing link
to a spam filter and as amateur to a practice owner.

### The Supabase keep-alive — a launch blocker, not a nicety

Supabase pauses a free project after seven idle days. A paused project does not
degrade this demo, it breaks it outright: every link already sitting in a
prospect's inbox starts returning an error, and a dead link in a cold email is a
prospect you do not get a second attempt at. Between building the list and
sending the first batch, and again once a campaign goes quiet, seven days is
easy to reach.

`heartbeat/` is a second, deliberately tiny Worker that reads one row from
`prospects` on a daily cron. It is separate because OpenNext generates the demo
Worker's entrypoint and owns its exports — there is no supported place to hang a
`scheduled` handler off it without importing a build artifact, and an adapter
upgrade should not be able to take the keep-alive with it.

```bash
cd demo/heartbeat
npm install
npx wrangler secret put SUPABASE_URL --config wrangler.toml
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config wrangler.toml
npm run deploy

curl https://ctf-demo-heartbeat.<account>.workers.dev    # "ok: database reached"
```

Every `wrangler` command here needs `--config wrangler.toml` (`npm run deploy`
and `npm run dev` pass it). Without it wrangler finds the demo's
`wrangler.jsonc` in the folder above first, and deploys, or sets the secret on,
the demo instead.

Deploy it **before** the first email goes out, and check that URL returns `ok`.
It uses the service role key rather than the anon key on purpose: `anon` holds
no grants on these tables by design, so a request made with it can be refused at
the API layer without ever reaching Postgres — a heartbeat that reports success
while the project drifts towards a pause is worse than no heartbeat.

### Hope returns the website's callback requests

The same Worker runs a second cron, every five minutes. When someone asks for a
callback on cutthroughfaster.com, Hope phones them back through Vapi, inside
South African calling hours: weekdays 08:00 to 18:00 and Saturdays 09:00 to
13:00, never on a Sunday or public holiday. She says she is an AI and that the
call is recorded, finds out what they need, explains what CTF does, offers the
free demo, and sets up a call with Kamva. She never quotes a price. The script
is in [`heartbeat/src/callbackAssistant.ts`](heartbeat/src/callbackAssistant.ts);
the Vapi dashboard only supplies her voice.

Kamva is emailed after every call: her notes and the transcript when she spoke
to them; a request to call them when nobody answered twice (she tries once more
an hour after a missed call), when the call failed, or when the number is not
a South African one she can dial. Each lead's progress is in the `callback_*`
columns of `leads` ([migration 0012](migrations/0012_hope_callbacks_and_reply_watch.sql)).

- Setting `contacted_at` on a lead before Hope gets to it stops her calling.
- Requests from before 29 September 2026 are never called.
- Somebody she spoke to in the last seven days is not called again.
- At most 20 people are called in any 24 hours, three per run.

It stays off until all three Vapi secrets are set:

```bash
cd demo/heartbeat
npx wrangler secret put VAPI_PRIVATE_KEY --config wrangler.toml       # Vapi → API Keys → private key
npx wrangler secret put VAPI_PHONE_NUMBER_ID --config wrangler.toml   # Vapi → Phone Numbers → the number's id
npx wrangler secret put VAPI_ASSISTANT_ID --config wrangler.toml      # the demo's assistant, for its voice
npx wrangler secret put EMAIL_API_KEY --config wrangler.toml          # the same Resend key as the demo
npm run deploy
```

`LEAD_NOTIFY_TO` and `EMAIL_FROM` can be set the same way; they default to
hello@cutthroughfaster.com and website@mail.cutthroughfaster.com.

The number needs to be able to call South African numbers. A free number bought
inside Vapi cannot: Vapi refuses international calls from its own numbers. Use a
Twilio number or a SIP trunk imported into Vapi (see
[`app/docs/giving-hope-a-phone-number.md`](../app/docs/giving-hope-a-phone-number.md)),
ideally a South African one, since people are more likely to answer a local
number. Allow calls to South Africa in the provider's geographic permissions.

Watch it with `npx wrangler tail --config wrangler.toml`; each run logs one line,
naming leads only by id.

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
