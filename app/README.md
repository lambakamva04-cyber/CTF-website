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
| `shared/legal.ts` | Terms, privacy policy, operator agreement, sub-processors — versioned, so consent points at real text |
| `docs/incident-response.md` | What to do when personal information may have been exposed |
| `worker/lib/totp.ts` | RFC 6238 TOTP, tested against the specification's vectors |
| `worker/lib/twoFactor.ts` | Challenges, backup codes — the flow both sign-in paths share |
| `worker/lib/email.ts` | **Every email-provider detail lives here** |
| `assistants/hope.ts` | Hope's prompt, voice and analysis plan — versioned, not clicked into a dashboard |
| `docs/giving-hope-a-phone-number.md` | The four ways to get calls to her, and why a SIM cannot be one |

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

## Hope

Hope is CTF's own receptionist and the live demonstration of the product. Her
prompt, voice, timing and analysis plan live in `assistants/hope.ts` rather than
only in the Vapi dashboard, for the same reason the schema lives in
`migrations/`: something typed into a web form is not versioned, not reviewable,
and gone the day somebody clicks the wrong thing.

```bash
npm run assistant:preview                        # see the payload, no key needed
VAPI_PRIVATE_KEY=... npm run assistant:sync      # push it to Vapi
```

The `structuredDataPlan` at the bottom of that file is what the dashboard reads
to decide whether a call was booked, escalated or missed. Rename a field there
and every call quietly becomes "Inquiry" — nothing errors, the numbers just go
wrong. `tests/assistant.test.ts` asserts those fields against what
`deriveOutcome` actually consumes, along with the things Hope must always do:
disclose that she is an AI, say the call is recorded, hand over the moment
somebody asks for a person, and never quote a price.

Getting calls to her is a separate question with four answers — see
`docs/giving-hope-a-phone-number.md`. The short version: a personal cellphone
cannot be pointed at Vapi directly, but conditional call forwarding gets you the
same result.

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

**"This app … doesn't comply with Google's OAuth 2.0 policy", with an `http://`
redirect_uri in the request details,** is a different failure and does not mean
the URI is merely unregistered — an http callback cannot be registered at all
for a web client, so there is nothing to add in the console that would fix it.
It means the browser reached the platform over plain http; the callback is now
pinned to https regardless of how the request arrived, so this should not recur.
If it does, the request never reached this Worker — check that the hostname
resolves to it rather than to a parked page.

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

## The CTF admin console

A CTF admin gets the console instead of a dashboard. It shows every client
organization with its calls, bookings, booking rate, minutes against plan and
overage for this or last month (each in the client's own month), every client
login with whether it is active, a platform activity feed, and a notice
whenever a client adds a login. It shows no caller names, numbers, summaries or
transcripts; the admin API refuses the client routes outright.

What an admin can do:

- **Suspend** an organization: everyone in it is signed out and kept out until
  it is reactivated. Data is kept. For an unpaid subscription.
- **Disable** one login: reversible, and the client's owner cannot undo it.
- **Block** an organization or a login: permanent. Its email addresses go on a
  blocklist that sign-up, Google sign-in and "add a login" all check.

Suspend, disable and block each need a recorded reason and a fresh code from
the admin's authenticator app. One code covers five minutes of further actions.

Admin accounts are made in SQL, never in the app, and only inside CTF's own
organization (the one with `is_platform = 1`). The console refuses to act on
that organization or on another admin. A client cannot register or add a
cutthroughfaster.com address, or any Gmail spelling of cutthroughfaster@gmail.com.

```sh
node scripts/seed.mjs --org "Cut Through Faster" --email hello@cutthroughfaster.com \
  --name "Cut Through Faster" > ~/ctf-admin.sql
npx wrangler d1 execute ctf-app --remote --file ~/ctf-admin.sql
npx wrangler d1 execute ctf-app --remote --command "UPDATE organizations SET is_platform = 1, status = 'active', activated_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE slug = 'cut-through-faster'; UPDATE users SET platform_role = 'ctf_admin' WHERE email = 'hello@cutthroughfaster.com' AND org_id = (SELECT id FROM organizations WHERE slug = 'cut-through-faster');"
```

On first sign-in the admin accepts the terms and replaces the temporary
password. The console does not open until an authenticator app is enrolled, and
an admin cannot switch it off or fall back to email codes. Admin sessions end
after 30 minutes idle or 12 hours in total, and every admin sign-in is emailed
to all admins when `EMAIL_API_KEY` is set.

## Security model

- **Sessions** are opaque 256-bit tokens in an `HttpOnly; Secure; SameSite=Lax`
  cookie. Only their SHA-256 is stored, so a database leak cannot be replayed as
  a login. Idle timeout 12 hours, absolute 30 days.
- **HTTPS is not optional.** A plain-http request that reaches the edge is
  answered with a 308 to the same URL over https, before any handler runs, and
  https responses carry a year of HSTS. Both matter more than they look: the
  session cookie is `Secure`, so a browser silently discards it on an http
  response — sign-in appears to work and then bounces straight back to the
  sign-in screen, with nothing in the logs to say why. Google refuses an http
  OAuth callback outright. The upgrade is skipped for requests that did not come
  through Cloudflare, because `wrangler dev` rewrites both the request URL and
  the `Location` header and would otherwise loop.
- **Passwords** are PBKDF2-HMAC-SHA256, 210,000 iterations, per-user salt. The
  work factor is embedded in the stored hash and upgraded automatically on the
  next successful sign-in when it is raised.
- **Tenant isolation** is enforced by passing `org_id` from the session into the
  `WHERE` clause of every query that touches client data. A call id belonging to
  another client returns a plain 404.
- **Login rate limiting**: 5 failures per email and 30 per IP in a 15-minute
  window — higher per address because an office behind one NAT is many people on
  one IP. Unknown emails and wrong passwords take the same path and return the
  same message, so the endpoint cannot be used to enumerate clients.
- **CSRF**: `SameSite=Lax` plus an `Origin` check against `ALLOWED_ORIGINS` on
  every mutation.
- **Webhooks** fail closed. If `VAPI_WEBHOOK_SECRET` is unset the endpoint
  rejects everything rather than accepting anonymous writes, and deliveries are
  de-duplicated so Vapi's retries cannot double-count a call.
- **Two-factor authentication**, TOTP or emailed codes, off by default and
  enrolled per account from the Security panel. See below.
- **Audit log**: every sign-in, takeover, hang-up and password change is
  recorded in `audit_log` with actor, target and IP.
- **Breach response** is written down rather than improvised, in
  `docs/incident-response.md`: containment SQL, the queries that establish
  scope, and the 72-hour notification deadline the privacy policy commits to.

## Password rules

`shared/password.ts` holds the five requirements — 7 characters, a lowercase
letter, a capital, a number, a symbol — as data, and both sides use it. The
checklist a client watches tick green and the check the server enforces are the
same list evaluated twice. Duplicating them, a regex in a component and an `if`
in a route, is how a form goes all green and is then rejected on submit, which
reads as a broken product rather than a rejected password.

The character classes are Unicode-aware rather than `[a-z]`, so a client typing
Zoë or señora is typing letters, not symbols. Length counts code points, so four
emoji do not satisfy a seven-character rule. A space counts as a symbol on
purpose: a spaced passphrase is a good password, and refusing it teaches people
to pick worse ones.

**The 7-character minimum is worth revisiting.** Length buys far more than
composition does, and the four class rules do not make up the difference —
`Passw0rd!` satisfies every rule here and is on the first page of every cracking
dictionary. `MIN_PASSWORD_LENGTH` is the one number to change. The strength
meter is advisory and pushes past the minimum: all five rules met at exactly
seven characters reads "Fair", not "Strong".

## Two-factor authentication

Off until a client switches it on. Two methods: an authenticator app (TOTP), or
a six-digit code by email for people who will not install one.

- **The first factor never issues a session when 2FA is on.** Password sign-in
  returns a challenge id instead of a cookie; Google sign-in redirects back with
  one in the URL. A challenge is a row in `login_challenges` and grants nothing
  — deliberately, rather than a "half-authenticated" cookie with a flag on it,
  where one missed check turns a first factor into a full login.
- **TOTP is RFC 6238**, SHA-1 / 30s / 6 digits, written out in
  `worker/lib/totp.ts` and tested against the RFC's own vectors. SHA-1 is the
  right choice here and not a compromise: every authenticator app assumes it,
  and HMAC-SHA1 has no practical break.
- **Codes cannot be replayed.** The accepted step is stored on the user and
  anything at or below it is refused. That is why enrolling and immediately
  signing in gets "that code has already been used" — the enrolment spent it.
  The message says so rather than "incorrect", which is the same event and
  useless advice.
- **Seeds are encrypted at rest** with AES-GCM under `TOTP_ENCRYPTION_KEY`, a
  Worker secret rather than a database column. A TOTP seed is not like a
  password hash: whoever reads it can mint valid codes forever and invisibly, so
  a database dump alone must not defeat the factor. Unset key fails closed —
  never a default, which every deployment would share.
- **Backup codes** matter more here than most places. There is no self-service
  password reset, so an owner who loses their phone with no code has no way back
  in without someone editing D1. Ten are issued at enrolment, shown once, stored
  as hashes, and spent in a single statement so two racing requests cannot both
  redeem one.
- **Three independent limits** on guessing six digits: five attempts per
  challenge, five per address per quarter hour, and the challenge expiring after
  five minutes. They fail differently on purpose — the per-challenge cap alone
  is defeated by opening a fresh challenge per guess.

### Email codes and the sending address

`worker/lib/email.ts` is the one file that knows about the email provider, the
way `worker/lib/vapi.ts` is for Vapi. Workers cannot open SMTP connections, so
it is an HTTPS API.

**Codes cannot be sent from `cutthroughfaster@gmail.com`.** gmail.com publishes
an SPF record authorising Google's servers and nobody else, and Google does not
let you add a third party to it — the domain is not yours. Any provider sending
as `@gmail.com` fails SPF, fails DKIM alignment, and fails DMARC; Gmail and
Outlook mostly reject it outright. A one-time code in a spam folder is worse
than no second factor, because people switch it on and then cannot sign in.

So `EMAIL_FROM` defaults to a subdomain of `cutthroughfaster.com` — which CTF
does control and can publish SPF and DKIM for — and `EMAIL_REPLY_TO` defaults to
the CTF gmail, so replies still reach the address clients know.
`emailDiagnostics` flags a free-mail sender explicitly, because that
misconfiguration fails silently at the recipient rather than at send time.

## Privacy and POPIA

- **Three documents**, all versioned in `shared/legal.ts` and all accepted
  together at signup: terms of service, privacy policy, and an **operator
  agreement**. The last one matters legally — POPIA section 72 permits personal
  information to leave South Africa on the strength of a contract, and the
  database lives in Western Europe because D1 has no African region. The
  mitigation there has to be contractual; there is no setting that fixes it.
- **Sub-processors are named**, not described: Cloudflare, Vapi and Google,
  each with its location and whether it handles caller data. Rendered as a table
  on the privacy page.
- **Consent is append-only**. `terms_acceptances` gets one row per user per
  document version, never an update. `hasCurrentConsent` requires all three at
  their current versions, and the API refuses everything else until they are
  accepted, so the screens and the server cannot drift apart.
- **Callers agreed to nothing.** They are not users of this platform. The client
  is the responsible party for their callers' information and CTF is the
  operator — that division is what the operator agreement sets out, and it is
  what determines who notifies callers after a breach.
- **Liability is capped and indemnified** in sections 9 and 10 of the terms:
  total liability limited to twelve months of fees in aggregate, indirect and
  consequential loss excluded by name, and caller claims kept with the client
  rather than passed back to CTF. Both sections carry `emphasis: true`, which
  renders them boxed and labelled — section 49 of the Consumer Protection Act
  requires such a term to be conspicuous, and the CPA reaches small clients
  because a juristic person under the turnover threshold is a "consumer".
  The carve-outs (gross negligence, wilful misconduct, fraud, death or personal
  injury, POPIA operator duties) are not optional politeness: section 51 voids
  a term that excludes liability for gross negligence, and a cap with no
  carve-out risks being struck out whole, taking the protection with it. The
  unit tests assert all of it, including that the section numbers quoted on the
  consent screens still point at the right clauses.
- **Still outstanding, and not fixable in code**: an Information Officer has to
  be appointed and registered with the Information Regulator.
  `INFORMATION_OFFICER.registeredWithRegulator` is `false` until that is done.
  The documents are a working draft and want review by a South African
  practitioner before they are relied on.

## Loading states

Every wait in the product is a skeleton shaped like the thing being waited for,
not a spinner. A spinner occupies no space, so the content jumps into place when
it arrives; a skeleton holds the layout still.

- `src/components/Skeleton.tsx` has the primitives and the composed shapes:
  call rows, stat cards, the live-call card, table rows, and `DashboardSkeleton`
  — the whole page, used while the session is being fetched.
- **The boot skeleton is inline in `index.html`**, because between the first
  byte and React mounting there is a stylesheet and a ~230 kB bundle to fetch,
  and nothing in `src/` exists yet. It duplicates the dashboard layout on
  purpose and is written out longhand — the CSP is `script-src 'self'`, so it
  cannot be generated by an inline script. `main.tsx` clears it before mounting.
  If the dashboard layout changes materially, change this too or the handover
  becomes a visible jump.
- Headings a client already knows (`Performance`, `Recent Activity`) are drawn
  as real text while the values load. A page of uniform grey says nothing; a
  page with its headings in place says the data is on its way.
- The sweep animation is disabled under `prefers-reduced-motion`, leaving a flat
  block that still reads as a placeholder.
- `Spinner` remains in `ui.tsx` for waits with no shape to stand in for, and is
  currently unused outside the in-button case.

## Search engines

The platform is a private dashboard, so the default is that none of it is
indexed. The exception is the three legal documents, which are public by nature
and which the marketing site links to rather than keeping a second copy of — two
copies of your terms that can drift apart is a legal hazard, not just a
maintenance one.

- `worker/lib/seo.ts` holds the policy: `INDEXABLE_PATHS`, the `X-Robots-Tag`
  value per path, the canonical URL, and the sitemap.
- **The crawl policy is a header, not a meta tag.** Every client route is served
  from the same `index.html`, so a `<meta name="robots">` could not differ per
  URL — it would hide the legal pages along with the dashboard.
- `run_worker_first = ["/"]` in `wrangler.toml` exists for this: a request
  matching a built file normally skips the Worker, and `/` matches
  `index.html`, which would leave the sign-in page without its header. Hashed
  bundles under `/assets/` still come straight off the edge.
- `/sitemap.xml` is **generated by the Worker** from `CURRENT_VERSIONS`, so
  `lastmod` is the date each document actually changed. A hand-maintained
  sitemap goes stale the first time someone edits a policy and forgets, and a
  wrong `lastmod` teaches Google to stop trusting the file.
- `CANONICAL_ORIGIN` pins the one address these pages are published at. The
  Worker also answers on `workers.dev` with identical content; without this the
  two compete for the same pages.
- **A caveat on local verification**: `wrangler dev` substitutes vars whose
  value matches a configured route with the local dev address, on the
  asset-fallback path. Header presence, absence and the sitemap body verify
  locally; the exact canonical hostname only proves out after a deploy.

The marketing site (`ctf-website/public/`) has its own `robots.txt`, `sitemap.xml`
and a `<link rel="canonical">`. It is one page — About, Pricing and Contact are
anchors on it — so its sitemap has one URL, which is correct. Submit the two
sites as separate properties in Search Console.

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
