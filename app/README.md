# CTF Control Platform

The dashboard Cut Through Faster clients sign into to watch their AI receptionist
work: live transcripts as a call happens, one tap to take the call over onto
their own phone, one tap to end it, and the history and booking numbers behind
it.

Runs as a single Cloudflare Worker serving both the React SPA and the API, with
D1 for storage and Vapi for the calls themselves.

```
Caller ──▶ Vapi assistant ──webhook──▶ Worker ──▶ D1
                  ▲                       ▲        │
                  │                       │        │ polled
             control URL           session cookie  ▼
                  └───────── takeover / hang up ── React SPA
```

## Layout

| Path | What it is |
| --- | --- |
| `src/` | React SPA (login, dashboard, live call panel) |
| `worker/` | API, auth, Vapi webhook and call control |
| `worker/lib/vapi.ts` | **Every Vapi-specific detail lives here** — the one file to change if Vapi's payloads move or you swap providers |
| `shared/types.ts` | API contract, typechecked on both sides |
| `migrations/` | D1 schema |
| `scripts/seed.mjs` | Onboards one client (org + first login) |
| `tests/` | Unit tests for auth crypto, webhook handling and date maths |

## First deploy

Requires a Cloudflare account on the **Workers Paid** plan. Password hashing
runs 210,000 PBKDF2 iterations, which exceeds the free plan's 10 ms CPU cap on
the login request. Everything else fits comfortably in the free tier.

```bash
cd app
npm install

# 1. Create the database and paste the printed id into wrangler.toml
npx wrangler d1 create ctf-app

# 2. Apply the schema
npm run db:migrate

# 3. Set secrets (see .dev.vars.example for what each one is)
npx wrangler secret put VAPI_PRIVATE_KEY
npx wrangler secret put VAPI_WEBHOOK_SECRET

# 4. Build and ship
npm run deploy
```

Then attach the custom domain: Cloudflare dashboard → Workers & Pages → `ctf-app`
→ Settings → Domains & Routes → add `app.cutthroughfaster.com`. Update
`ALLOWED_ORIGINS` in `wrangler.toml` if you use a different hostname, and
redeploy — the API refuses cookie-bearing mutations from origins not on that
list.

## Connecting a client's Vapi assistant

1. In Vapi, open the assistant and set its **Server URL** to
   `https://app.cutthroughfaster.com/api/vapi/webhook`, with **Server Secret**
   set to the same value you put in `VAPI_WEBHOOK_SECRET`.

2. Subscribe the assistant to these server events. The dashboard is built around
   exactly these three:

   | Event | What it drives |
   | --- | --- |
   | `status-update` | the live call appearing and disappearing, plus the control URL used by takeover |
   | `transcript` | transcript lines during the call |
   | `end-of-call-report` | outcome, summary, recording, final duration |

3. Configure the assistant's **structured data plan** so it reports what the
   call achieved. Without it the dashboard still works, but every completed call
   falls back to "Inquiry" instead of showing bookings:

   ```json
   {
     "type": "object",
     "properties": {
       "outcome":     { "type": "string", "enum": ["booked", "inquiry", "escalated", "missed"] },
       "service":     { "type": "string", "description": "Service booked, if any" },
       "bookingWhen": { "type": "string", "description": "Human-readable slot, e.g. 'Wed, 2:30pm'" },
       "callerName":  { "type": "string" }
     }
   }
   ```

4. Onboard the client and link the assistant:

   ```bash
   node scripts/seed.mjs \
     --org "Riverside Dental Studio" \
     --email owner@riversidedental.co.za \
     --name "Dr Naledi Dube" \
     --phone "082 555 0134" \
     --assistant-id asst_xxxxxxxx \
     --phone-number-id pn_xxxxxxxx \
     --services "Check-up & Cleaning,Filling,Whitening Consult" \
     > seed-riverside.sql

   npx wrangler d1 execute ctf-app --remote --file seed-riverside.sql
   ```

   The temporary password is printed to your terminal, never into the SQL file.
   The account is flagged so the client must replace it at first sign-in.

Webhooks are matched to a client by `vapi_assistant_id` first, then
`vapi_phone_number_id`. Either one is enough; setting both is more robust.

## How takeover works

Taking over is a **warm transfer**, not a browser mic:

1. Staff tap *Take Over Call* and confirm the number to ring (their profile
   number by default, editable in the dialog).
2. The Worker POSTs `{"type":"transfer","destination":{...}}` to the call's live
   control URL. The AI tells the caller it is putting them through.
3. Vapi rings the staff number and bridges the two. The caller is never dropped.
4. The call shows as *Transferring*, and the dashboard stops offering takeover
   but still offers *End Call*.

Numbers are normalised to E.164 before dispatch (`082 555 0134` → `+27825550134`),
because Vapi silently fails to ring anything else.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in the Vapi values
npm run db:migrate:local
node scripts/seed.mjs --org "Test Practice" --email you@example.com --name "You" --password "a-long-dev-password" > seed-dev.sql
npx wrangler d1 execute ctf-app --local --file seed-dev.sql

npm run dev:worker   # API on :8787
npm run dev          # SPA on :5173, proxying /api to the Worker
```

Set `PBKDF2_ITERATIONS=10000` in `.dev.vars` if local logins feel slow.

```bash
npm test        # unit tests
npm run typecheck
npm run build
```

## Security model

- **Sessions** are opaque 256-bit tokens in an `HttpOnly; Secure; SameSite=Lax`
  cookie. Only their SHA-256 is stored, so a database leak cannot be replayed as
  a login. Idle timeout 12 hours, absolute 30 days.
- **Passwords** are PBKDF2-HMAC-SHA256, 210,000 iterations, per-user salt. The
  work factor is embedded in the stored hash and upgraded automatically on the
  next successful sign-in when it is raised.
- **Tenant isolation** is enforced by passing `org_id` from the session into the
  `WHERE` clause of every query that touches client data. A call id belonging to
  another client returns a plain 404.
- **Login rate limiting**: 8 failures per email and 30 per IP in a 15-minute
  window. Unknown emails and wrong passwords take the same path and return the
  same message, so the endpoint cannot be used to enumerate clients.
- **CSRF**: `SameSite=Lax` plus an `Origin` check against `ALLOWED_ORIGINS` on
  every mutation.
- **Webhooks** fail closed. If `VAPI_WEBHOOK_SECRET` is unset the endpoint
  rejects everything rather than accepting anonymous writes, and deliveries are
  de-duplicated so Vapi's retries cannot double-count a call.
- **Audit log**: every sign-in, takeover, hang-up and password change is
  recorded in `audit_log` with actor, target and IP.

## Operational notes

- **Polling, not websockets.** Live call state refreshes every 3 s and the
  transcript every 2 s, using a cursor so only new lines are fetched. Polling
  pauses while the tab is hidden and backs off exponentially on errors, with the
  last good data left on screen.
- **Nightly cron** (`17 3 * * *`) prunes expired sessions, old rate-limit rows
  and webhook dedupe ids.
- **Recovering a locked-out client**: generate a new hash with
  `node scripts/seed.mjs` for a throwaway org, copy the `password_hash`, and
  `UPDATE users SET password_hash = '...', must_change_password = 1 WHERE email = '...'`.
  Their other sessions are revoked automatically the next time they change it.
- **A client sees no calls**: check `organizations.vapi_assistant_id` matches the
  assistant, then `npx wrangler tail ctf-app` and look for
  `webhook_org_unresolved`.

## Known gaps

These are deliberate omissions, not oversights — each is a decision to make
before or shortly after launch:

- **No self-service password reset.** There is no email sender wired up, so a
  forgotten password is an operator action (see above). Add a reset flow once an
  email provider is chosen.
- **No admin UI.** Adding clients and staff logins is the seed script plus
  `wrangler d1 execute`. Fine for the first handful of clients; it will not scale
  past a few dozen.
- **No live audio.** Staff read the transcript and take over by phone; they
  cannot listen in from the browser. Vapi exposes a `listenUrl` websocket (it is
  already stored on each call) if you later want monitoring.
- **Recordings are served from Vapi's URLs**, which may expire. If clients need
  long-term access, copy them to R2 on `end-of-call-report`.
