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

**Already done** — the D1 database `ctf-app` exists in the account
(`2864d4e4-dc2b-4016-8775-6da6f93c0d27`, Western Europe), its schema is applied,
the migration is recorded in `d1_migrations` so `npm run db:migrate` is a no-op,
and a first owner login is seeded. `wrangler.toml` already points at it.

What is left is the deploy itself, which needs credentials:

```bash
cd app
npm install
npx wrangler login      # or export CLOUDFLARE_API_TOKEN=...
npm run deploy
```

That publishes the Worker, serves it on `ctf-app.<account>.workers.dev`, and —
because of the `[[routes]]` block in `wrangler.toml` — creates the DNS record
and TLS certificate for `app.cutthroughfaster.com` automatically.

> If the deploy fails with an error naming the zone `cutthroughfaster.com`, the
> domain's DNS is not on this Cloudflare account. Comment out the `[[routes]]`
> block and re-run; the workers.dev URL still works, and the domain can be
> attached later from Workers & Pages → `ctf-app` → Settings → Domains & Routes.

Then add the Vapi secrets, without which the webhook fails closed and call
control is unavailable:

```bash
npx wrangler secret put VAPI_PRIVATE_KEY
npx wrangler secret put VAPI_WEBHOOK_SECRET
```

`ALLOWED_ORIGINS` in `wrangler.toml` lists extra origins permitted to send
cookie-bearing mutations. Same-origin requests are always allowed, so both the
workers.dev URL and the custom domain work without changing it.

## Connecting a client's Vapi assistant

1. In Vapi, open the assistant and set its **Server URL** to
   `https://app.cutthroughfaster.com/api/vapi/webhook`, with **Server Secret**
   set to the same value you put in `VAPI_WEBHOOK_SECRET`.

   If Vapi asks which credential type to use, pick **Bearer Token** (or a plain
   secret if offered) and paste the same value. Both arrive as a shared secret —
   `Authorization: Bearer …` or `x-vapi-secret` — and the Worker accepts either.

   **Do not pick OAuth 2.0.** It is meant for calling an API that mints
   short-lived tokens, which this endpoint does not do; there is nothing for the
   Worker to validate against and every delivery would be rejected.

   **HMAC** is supported as an *additional* layer, not a replacement: set
   `VAPI_WEBHOOK_HMAC_SECRET` and an `x-vapi-signature` header covering the raw
   body is then required as well. It is strictly stronger — a shared secret
   replayed from a captured request still authenticates, while an HMAC is bound
   to the exact body — but the header name and digest encoding have not been
   verified against a live Vapi deployment. Get the shared secret working first,
   then add HMAC and confirm with `wrangler tail` before relying on it.

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

### If wrangler will not start

```
Error: The package "@cloudflare/workerd-<platform>" could not be found,
and is needed by workerd.
```

`npm install` skipped an optional dependency — a long-standing npm bug
([npm/cli#4828](https://github.com/npm/cli/issues/4828)), most often seen on
Windows. The lockfile is not the problem: it pins all five `workerd` platform
binaries, and `npm ls @cloudflare/workerd-windows-64` will confirm which one is
missing from the installed tree.

Reinstall cleanly from the lockfile rather than deleting it — regenerating the
lockfile on one platform is what causes the mirror-image failure elsewhere:

```bash
rm -rf node_modules
npm ci
```

Failing that, add the one binary without touching the lockfile, matching the
`workerd` version exactly:

```bash
npm install @cloudflare/workerd-windows-64@<workerd version> --no-save
```

Also check `npm config get omit` — if it prints `optional`, every optional
dependency is being skipped by configuration; clear it with
`npm config delete omit`.

## Sign-in with Google

Optional. Without `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` the button is
hidden and the routes return 404, so password sign-in is unaffected.

1. Google Cloud console → **APIs & Services → Credentials → Create OAuth client
   ID → Web application**.
2. Add every hostname the dashboard is served from as an authorised redirect
   URI — the callback is derived from the request origin, so each one must be
   registered separately:
   - `https://app.cutthroughfaster.com/api/auth/google/callback`
   - `https://ctf-app.<account>.workers.dev/api/auth/google/callback`
   - `http://localhost:8787/api/auth/google/callback` for local development
3. `npx wrangler secret put GOOGLE_CLIENT_ID` and the same for the secret.

To see exactly what a given hostname will send, open `/api/auth/methods` on it:

```json
{ "google": true, "redirectUri": "https://app.cutthroughfaster.com/api/auth/google/callback" }
```

`Error 400: redirect_uri_mismatch` means that string is not registered on the
OAuth client. Two things to check before anything else: it must go under
**Authorised redirect URIs**, not *Authorised JavaScript origins* — they are
different fields and the second one does not satisfy this — and it must match
character for character, including scheme and any trailing slash.

**Google sign-in never creates an account.** It matches the verified Google
email against a login that already exists, and refuses anything else — the
dashboard exposes live calls and caller phone numbers, so having a Google
account must not be a way in. On first successful use the Google subject id is
bound to the login, so a later change of email address at Google still matches.

An unverified Google email is rejected outright: it proves nothing about who
controls the mailbox.

## Who can do what

Roles are enforced in the Worker, on every request. The permissions the client
receives in `/api/me` only drive what the UI offers; the API re-checks each one.

| | Owner | Staff |
| --- | :---: | :---: |
| See calls, transcripts, recordings, metrics | ✅ | ✅ |
| Take a call over onto a phone, end a call | ✅ | ✅ |
| Add, edit, disable logins | ✅ | — |
| Reset another user's password | ✅ | — |
| Change organization settings | ✅ | — |

Both are scoped to their own organization: tenancy is enforced separately, by
passing `org_id` into every query, and is not something a role can widen.

Guards worth knowing about:

- An owner cannot disable or demote themselves, and the last active owner in an
  organization cannot be removed — otherwise a client could lock themselves out
  of their own dashboard.
- Disabling a login, or resetting its password, revokes that user's sessions
  immediately rather than waiting for them to expire.
- Temporary passwords are shown exactly once, at the moment they are issued.
  They are never stored in readable form and cannot be retrieved afterwards.

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
  forgotten password is reset by an owner from the Team panel, which issues a
  new temporary password. A client whose only owner is locked out still needs
  you to reset it via `wrangler d1 execute`.
- **No cross-client admin UI.** Owners manage logins inside their own
  organization, but creating a new *client* is still the seed script plus
  `wrangler d1 execute`. Fine for the first handful of clients.
- **No live audio.** Staff read the transcript and take over by phone; they
  cannot listen in from the browser. Vapi exposes a `listenUrl` websocket (it is
  already stored on each call) if you later want monitoring.
- **Recordings are served from Vapi's URLs**, which may expire. If clients need
  long-term access, copy them to R2 on `end-of-call-report`.
