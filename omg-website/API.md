# OMG booking and reviews API

The Worker in `src/` serves the static site from `public/` and answers
`/api/*`. Data lives in one D1 database (binding `DB`).

Shared code: `public/js/catalog.js` (services, durations, hours, the WhatsApp
message) and `public/js/slots.js` (time and date arithmetic) are loaded by the
browser **and** bundled into the Worker. Neither side keeps its own copy.

All times are SAST (UTC+2, no daylight saving). Dates are `YYYY-MM-DD`, times
`HH:MM`, ranges half-open (`09:00–10:30` then `10:30–12:00` do not overlap).

## Conventions

- Every response is JSON with `ok: true | false`.
- Errors: `{ ok: false, error: "<code>", message: "<safe to show a visitor>", field?: "<name>" }`.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid` | A field failed validation (`field` names it) |
| 401 | `unauthorized` | Admin route without a valid session |
| 401 | `bad_password` | Wrong admin password |
| 403 | `forbidden` | State-changing request whose `Origin` is missing or not this site |
| 404 | `not_found` | Unknown route or id |
| 405 | `method_not_allowed` | Wrong method (`Allow` header lists the right ones) |
| 409 | `taken` | Booking request for a time that is not free |
| 409 | `overlap` | Admin block or confirm that overlaps another block (`conflicts` lists them) |
| 413 | `too_large` | Body over 8 KB |
| 415 | `unsupported_media_type` | POST body that is not `application/json` |
| 429 | `rate_limited` | Limit hit. `Retry-After` header and `retryAfter` (seconds) in the body |
| 500 | `server_error` | Anything unexpected. No internal detail is ever returned |
| 503 | `not_configured` | Admin login when `ADMIN_PASSWORD` is missing or shorter than 12 characters |

- `POST`/`DELETE` to `/api/*` must carry an `Origin` header equal to the site's
  own origin, or they are refused with 403 (cross-site request forgery).
- `POST` bodies must be `Content-Type: application/json` and at most 8 KB.
- All SQL uses prepared statements with bound parameters. No value from a
  request is ever placed into SQL text.
- API responses carry `Cache-Control: no-store` unless stated otherwise.

## Public endpoints

### `GET /api/availability?month=YYYY-MM`

Busy time on each day of a month, so the calendar can show what is free. Only
time ranges: never names, numbers, services or notes. Months from the current
month to 12 months ahead; anything else is 400.

```json
{
  "ok": true,
  "month": "2026-12",
  "today": "2026-11-14",
  "now": "14:35",
  "busy": { "2026-12-05": [["09:00", "10:30"], ["13:00", "18:00"]] }
}
```

`busy` lists only days that have something booked or blocked, merged and
sorted. Pending requests are **not** busy (otherwise anyone could fill the
calendar with fake requests); only bookings OMG has confirmed and time OMG has
blocked off. `today`/`now` are SAST, so the page does not trust the visitor's
clock for minimum notice.

### `POST /api/bookings`

A visitor asks for a time. Stored as a **pending request** for OMG to confirm.

```json
{ "name": "Thandi Mokoena", "phone": "082 123 4567", "service": "full-glam",
  "date": "2026-12-12", "time": "09:00", "company": "", "elapsed": 41250 }
```

- `name`: "Name and Surname". Trimmed, inner whitespace collapsed, 3–80
  characters, at least two words, letters (any script) plus `space ' - .`.
- `phone`: "Contact Number". Digits, spaces, `+ - ( )`; 9–15 digits in total.
- `service`: an `id` from `SERVICES` in `catalog.js`.
- `date` + `time`: must pass `isBookable` against confirmed bookings and
  blocks for that date, the opening hours, the 30-minute grid, the minimum
  notice and the booking window, all from `catalog.js`.
- `company`: honeypot, hidden from people. Non-empty → reply 201 as if it
  worked, store nothing.
- `elapsed`: milliseconds the form was open. Under 2000 → treated like the
  honeypot.

`201`:

```json
{ "ok": true, "ref": "OMG-7K2P",
  "whatsappUrl": "https://wa.me/27785767604?text=...",
  "summary": { "name": "Thandi Mokoena", "phone": "082 123 4567",
               "service": "Full Glam (R850)", "when": "Saturday 12 December 2026 at 09:00" } }
```

`whatsappUrl` is built with `bookingMessage()` from `catalog.js`. `ref` is
`OMG-` plus four characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, unique.
A second identical request (same phone, date and time) within 10 minutes
returns the first request's `ref` instead of storing a duplicate.

`409 taken` when the time is no longer free. The page should reload the month.

### `GET /api/reviews?page=1`

Approved reviews, newest first, six per page. `Cache-Control: public, max-age=60`.

```json
{ "ok": true, "average": 3.75, "count": 12, "page": 1, "hasMore": true,
  "reviews": [ { "id": 7, "name": "Lerato M.", "rating": 4, "comment": "...", "date": "2026-11-02" } ] }
```

`average` is over all approved reviews, rounded to 2 decimals, `null` when
there are none. Ratings are out of **4**.

### `POST /api/reviews`

```json
{ "name": "Lerato M.", "rating": 4, "comment": "...", "company": "", "elapsed": 30500 }
```

- `name`: 2–40 characters after trimming, letters, spaces, `' - .`.
- `rating`: the integer 1, 2, 3 or 4 (not `"4"`, not `3.5`).
- `comment`: 10–500 characters after trimming. Links are refused (`http://`,
  `https://`, `www.`), so spam cannot advertise through it.
- `company` / `elapsed`: as for bookings.

Text fields are normalised to NFC; control characters and zero-width or
bidirectional-override characters are removed before checking lengths.

`201 { "ok": true }`. The review is stored **pending** and appears only after
OMG approves it on the admin page.

## Admin endpoints

The admin page is `/admin/`. Every `/api/admin/*` route except `login` needs
the session cookie, otherwise 401.

| Method and path | Body | Reply |
| --- | --- | --- |
| `POST /api/admin/login` | `{ "password" }` | `{ ok }` and sets the session cookie |
| `POST /api/admin/logout` | none | `{ ok }`, clears the cookie |
| `GET /api/admin/session` | | `{ ok, pending: { requests, reviews } }` |
| `GET /api/admin/requests` | | `{ ok, requests: [Request] }` pending only, soonest first |
| `POST /api/admin/requests/:id/confirm` | `{ "minutes"?, "force"? }` | `{ ok, block }`; 409 `overlap` unless `force` |
| `POST /api/admin/requests/:id/decline` | none | `{ ok }`, deletes the request |
| `GET /api/admin/blocks?from=&to=` | | `{ ok, blocks: [Block] }`, range at most 62 days |
| `POST /api/admin/blocks` | `{ date, start, end, kind, label?, force? }` | `201 { ok, block }`; 409 `overlap` unless `force` |
| `DELETE /api/admin/blocks/:id` | | `{ ok }` |
| `GET /api/admin/reviews?status=pending\|approved` | | `{ ok, reviews: [AdminReview] }` |
| `POST /api/admin/reviews/:id/approve` | none | `{ ok }` |
| `DELETE /api/admin/reviews/:id` | | `{ ok }` |

- `Request`: `{ id, ref, name, phone, service, serviceName, price, date, time, minutes, createdAt }`.
- `Block`: `{ id, date, start, end, kind: "booking" | "closed", label, ref, name, phone, service }`.
  `ref`/`name`/`phone`/`service` are present when the block came from a confirmed request, else `null`.
- `AdminReview`: `{ id, name, rating, comment, status, createdAt }`.
- Block times: `start` < `end`, both on 5-minute boundaries, `end` may be `24:00`.
  `kind: "closed"` is time off. `label` is a private note, at most 80 characters, never shown publicly.
- Confirming a request creates a `booking` block from its start for `minutes`
  (default: the service's duration from `catalog.js`), labelled with the client's name.
- `:id` must be a positive integer; anything else is 404.

### Session

- Login compares the password with the `ADMIN_PASSWORD` secret in constant time.
- On success the Worker creates a random 32-byte token, stores only its SHA-256
  hash in D1 with a 14-day expiry, and sets
  `__Host-omg_admin=<token>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=1209600`.
- Logout deletes the session row and expires the cookie.

## Rate limits

Every attempt counts against the "any attempt" limits, so nobody can hammer
a form. Only what is actually saved counts against the tighter limits, so a
visitor who gets a field wrong is not locked out.

Fixed-window counters in D1, keyed by a salted SHA-256 of the client IP
(`CF-Connecting-IP`). Raw IPs are never stored. The salt is a random value
created once and kept in the `settings` table.

| What | Limit per IP | Across everyone |
| --- | --- | --- |
| `GET /api/availability`, `GET /api/reviews` | 120 a minute | |
| `POST /api/bookings`, any attempt | 30 an hour | |
| `POST /api/bookings`, requests saved | 5 an hour | 300 a day |
| `POST /api/reviews`, any attempt | 20 an hour | |
| `POST /api/reviews`, reviews saved | 3 a day | 100 a day |
| `POST /api/admin/login` | 5 per 15 minutes | 30 failed logins an hour |
| Other `/api/admin/*` | 300 a minute | |

## Security headers

On every response (pages, files and API):

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'; manifest-src 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
Cross-Origin-Opener-Policy: same-origin
```

Over HTTPS also `Strict-Transport-Security: max-age=31536000` and
`upgrade-insecure-requests` in the CSP. `/admin/` and `/api/` also get
`X-Robots-Tag: noindex, nofollow`, and `/admin/` gets `Cache-Control: no-store`.

`script-src 'self'` means no inline scripts and no inline event handlers:
every script is a file under `public/js/`. The JSON-LD block is data, not a
script, so it is unaffected.

## Keeping personal data short-lived

A daily cron (`[triggers]` in `wrangler.toml`) deletes:

- pending requests whose date has passed or that are over 30 days old;
- confirmed requests, and the client details on their blocks, 30 days after the appointment;
- blocks more than 180 days in the past;
- expired sessions and rate-limit counters.
