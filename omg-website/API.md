# OMG booking and reviews API

The Worker in `src/` serves the static site from `public/` and answers
`/api/*`. Data lives in one D1 database (binding `DB`).

Shared code: `public/js/catalog.js` (opening hours, the booking rules, the
WhatsApp message) and `public/js/slots.js` (time and date arithmetic) are
loaded by the browser **and** bundled into the Worker. The services (names,
prices, durations) are rows in the `services` table, edited on the admin
page: the Worker checks bookings against them and writes the same rows into
the page for the booking calendar. Neither side keeps its own copy.

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
| 403 | `bad_code` | Admin setup with a setup code that is wrong, used or expired |
| 404 | `not_found` | Unknown route or id |
| 405 | `method_not_allowed` | Wrong method (`Allow` header lists the right ones) |
| 409 | `taken` | Booking request for a time that is not free |
| 409 | `overlap` | Admin block or confirm that overlaps another block (`conflicts` lists them) |
| 413 | `too_large` | Body over 8 KB |
| 415 | `unsupported_media_type` | POST body that is not `application/json` |
| 429 | `rate_limited` | Limit hit. `Retry-After` header and `retryAfter` (seconds) in the body |
| 500 | `server_error` | Anything unexpected. No internal detail is ever returned |
| 503 | `not_configured` | Admin login while no password is set (none set with a setup code, and no `ADMIN_PASSWORD` of 12+ characters) |

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
sorted, including times busy in OMG's own calendar once she has linked it
(see *Phone calendar*). Pending requests are **not** busy (otherwise anyone could fill the
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
- `service`: the `id` of a service that is shown on the site (`services.visible = 1`).
- `date` + `time`: must pass `isBookable` against confirmed bookings and
  blocks for that date, the opening hours, the 30-minute grid, the minimum
  notice and the booking window, all from `catalog.js`.
- `company`: honeypot, hidden from people. The page's field is named and labelled so that browser autofill never fills it (a field called "Company" was filled by Chrome, and the request then looked like a bot's). Non-empty → reply 201 as if it
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

Approved reviews, newest first, six per page. Not cached, so an approval shows at once.

```json
{ "ok": true, "average": 3.75, "count": 12, "page": 1, "hasMore": true,
  "reviews": [ { "id": 7, "name": "Lerato M.", "rating": 4, "comment": "...", "date": "2026-11-02" } ] }
```

`average` is over all approved reviews, rounded to 2 decimals, `null` when
there are none. Ratings are out of **5**.

### `POST /api/reviews`

```json
{ "name": "Lerato M.", "rating": 4, "comment": "...", "company": "", "elapsed": 30500 }
```

- `name`: 2–40 characters after trimming, letters, spaces, `' - .`.
- `rating`: the integer 1, 2, 3, 4 or 5 (not `"5"`, not `4.5`).
- `comment`: 2–500 characters after trimming (short praise such as "Amazing!" is a review; OMG approves each one). Links are refused (`http://`,
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
| `POST /api/admin/setup` | `{ "code", "password" }` | `{ ok }`, sets the password and the session cookie (see Session) |
| `POST /api/admin/logout` | none | `{ ok }`, clears the cookie |
| `GET /api/admin/session` | | `{ ok, pending: { requests, reviews } }` |
| `GET /api/admin/requests` | | `{ ok, requests: [Request] }` pending only, soonest first |
| `POST /api/admin/requests/:id/confirm` | `{ "minutes"?, "force"? }` | `{ ok, block }`; 409 `overlap` unless `force` |
| `POST /api/admin/requests/:id/decline` | none | `{ ok }`, deletes the request |
| `GET /api/admin/blocks?from=&to=` | | `{ ok, blocks: [Block], external: { date: [[start, end]] } }`, range at most 62 days; `external` is what is busy in OMG's own calendar |
| `POST /api/admin/blocks` | `{ date, start, end, kind, label?, force? }` | `201 { ok, block }`; 409 `overlap` unless `force` |
| `DELETE /api/admin/blocks/:id` | | `{ ok }` |
| `GET /api/admin/reviews?status=pending\|approved` | | `{ ok, reviews: [AdminReview] }` |
| `POST /api/admin/reviews/:id/approve` | none | `{ ok }` |
| `DELETE /api/admin/reviews/:id` | | `{ ok }` |
| `GET /api/admin/push/key` | | `{ ok, publicKey }`, the VAPID public key (base64url) |
| `POST /api/admin/push/subscribe` | `{ endpoint }` | `{ ok }`; keeps the newest 10 devices |
| `POST /api/admin/push/unsubscribe` | `{ endpoint }` | `{ ok }` |
| `POST /api/admin/push/test` | none | `{ ok, devices, sent }`: alerts every device now |
| `GET /api/admin/push/latest` | | `{ ok, title, body, tag }`: what the alert that just arrived should say |

- `Request`: `{ id, ref, name, phone, service, serviceName, price, date, time, minutes, createdAt }`.
- `Block`: `{ id, date, start, end, kind: "booking" | "closed", label, ref, name, phone, service }`.
  `ref`/`name`/`phone`/`service` are present when the block came from a confirmed request, else `null`.
- `AdminReview`: `{ id, name, rating, comment, status, createdAt }`.
- Block times: `start` < `end`, both on 5-minute boundaries, `end` may be `24:00`.
  `kind: "closed"` is time off. `label` is a private note, at most 80 characters, never shown publicly.
- A 409 `overlap` lists `conflicts: [{ id, start, end, kind, label }]`. A time
  busy in OMG's own calendar appears as `{ id: null, kind: "calendar", label: null }`.
- Confirming a request creates a `booking` block from its start for `minutes`
  (default: the service's duration when the request was made), labelled with the client's name.
- `:id` must be a positive integer; anything else is 404.

### Session

- The password is set on the admin page with a **one-time setup code**:
  `npm run admin:setup-code` stores the SHA-256 of 16 random characters (from
  `ABCDEFGHJKMNPQRSTUVWXYZ23456789`) with a 24-hour expiry in `settings`
  (`admin_setup`). `POST /api/admin/setup` checks the code in constant time,
  uses it up (one request wins a race), stores the password as PBKDF2-SHA256
  (20,000 iterations, random 16-byte salt; about 5 ms, inside the free plan's
  CPU allowance) in `settings` (`admin_password`), signs every device out and
  signs this browser in. A wrong, used or expired code is 403 `bad_code`;
  a password under 12 characters is 400 and leaves the code usable.
- Login checks the password set that way. Until one is set, it compares with
  the `ADMIN_PASSWORD` secret in constant time; with neither, it is 503.
- On success the Worker creates a random 32-byte token, stores only its SHA-256
  hash in D1 with a 14-day expiry, and sets
  `__Host-omg_admin=<token>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=1209600`.
- Logout deletes the session row and expires the cookie.

### Website content (the Website tab)

| Method and path | Body | Reply |
| --- | --- | --- |
| `GET /api/admin/site` | | `{ ok, services: [Service], text: { phone, instagram, facebook_url, facebook_name, area, tagline, home_calls, bridal_note }, photos: [Photo] }`, hidden services included |
| `POST /api/admin/site/services` | `ServiceInput` | `201 { ok, service }`, last in its card, id made from the name (`lash-lift-k3f9`) |
| `POST /api/admin/site/services/:id` | `ServiceInput` | `{ ok, service }`, every field replaced; a new card puts it last there |
| `DELETE /api/admin/site/services/:id` | | `{ ok }`. Requests already made keep their details |
| `POST /api/admin/site/services-order` | `{ card, ids }` | `{ ok }`. `ids` must be exactly that card's services |
| `POST /api/admin/site/text` | any of the text keys | `{ ok, text }` with the stored (normalised) values |
| `POST /api/admin/site/photos` | multipart: `album`, `alt`, `width`, `height`, `small_width`, `large`, `small` | `201 { ok, photo }`, last in its album |
| `POST /api/admin/site/photos/:id` | `{ alt }` | `{ ok, photo }` |
| `DELETE /api/admin/site/photos/:id` | | `{ ok }`, and an uploaded photo's files are deleted |
| `POST /api/admin/site/photos-order` | `{ album, ids }` | `{ ok }`. `ids` must be exactly that album's photos |

- `ServiceInput`: `{ card, name, price, minutes, note, level, details, visible }`.
  `card` is `makeup`, `hair`, `package`, `bride` or `bridesmaid`; `name` 2–60
  characters; `price` a whole number of rand, 0–100000; `minutes` 15–720 in
  steps of 15; `note` up to 60 characters or `null`; `level` 1–3 (makeup only)
  or `null`; `details` up to 1000 characters and 30 lines (package only: one
  item per line, a line ending in `:` is a heading); `visible` a boolean.
- Text: `phone` is stored as country code and digits (`078 576 7604` →
  `27785767604`); `instagram` as a username (`@name` or a profile link is
  accepted); `facebook_url` must be on `facebook.com`, `fb.com` or `fb.me` and is
  stored as `https`; empty `instagram` or `facebook_url` hides it. `area` (the
  place OMG works in, e.g. `Soweto, Johannesburg`) 0–28 characters: it goes into
  the page title, the H1, the description, the schema.org address and
  `/llms.txt`, and empty names no place. `tagline` 10–220 characters,
  `home_calls` and `bridal_note` 5–300.
- Photos: `album` is `looks` or `before_after`; `alt` 3–160 characters that
  describe the photo (a camera file name such as `IMG_2041.jpg` is refused); the
  admin page shrinks each photo before sending, to the size its album shows it
  (`looks` at most 720×1100 with a 360px copy, `before_after` 1080×1660 with a
  720px copy). Only JPEG and WebP are accepted, recognised by their first bytes (not
  the declared type): large at most 3 MB, small 1 MB, the whole upload 6 MB,
  40 photos per album.
- `GET /media/<32 hex>-<l|s>.<webp|jpg>` serves an uploaded photo from KV with
  `Cache-Control: public, max-age=31536000, immutable`. Any other name is 404.

The home page is rewritten as it is served (`HTMLRewriter`): the price lists,
the bridal package, both photo albums, the contact links, the description
tags, the JSON-LD and a `<script type="application/json" id="omg-catalog">`
block the booking calendar reads (`{ phone, services: [{ id, group, name,
price, minutes }] }`). Each Worker reuses the content for up to 15 seconds.
The page is sent with `Cache-Control: no-cache` and no ETag, so browsers never
show an old price list.

### Phone alerts (Web Push)

After a booking request or review is saved, the Worker sends a push to every
subscribed device (`ctx.waitUntil`, so the visitor never waits). The push has
**no body**: it only wakes the admin page's service worker (`/admin/sw.js`),
which calls `GET /api/admin/push/latest` with the session cookie and shows the
result. No personal data passes through the push services, so no payload
encryption is needed, only VAPID: an ES256 key pair the Worker creates once and
keeps in `settings` (`vapid`). The newest pending request or review from the
last 15 minutes is described, or the last test alert; otherwise the alert
counts what is waiting. Phone numbers are never in an alert.

- `endpoint` must be an `https:` address on a browser push service
  (`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com`,
  `*.notify.windows.com`), with no credentials or port, at most 1024
  characters. Anything else is 400 `invalid` (`field: "endpoint"`), so the
  Worker can never be made to send requests elsewhere.
- A push service answering 404 or 410 means the device is gone: its row is
  deleted.

### Phone calendar

Both ways between the site and OMG's own calendar (`src/calendar.js`).

| Method and path | Body | Reply |
| --- | --- | --- |
| `GET /api/admin/calendar-sync` | | `{ ok, feed: { https, webcal, seenAt }, import: Import }` |
| `POST /api/admin/calendar-sync/feed-reset` | none | `{ ok, feed }`: a new feed link; the old one is 404 at once |
| `POST /api/admin/calendar-sync/import` | `{ url }` | `{ ok, import }` once the calendar has been read; nothing is saved if it can't be |
| `POST /api/admin/calendar-sync/sync` | none | `{ ok, import }` after reading it now; 404 `not_connected` if none is linked |
| `DELETE /api/admin/calendar-sync/import` | | `{ ok, import: { connected: false } }`, and its busy times are forgotten |

- `Import`: `{ connected: false }`, or `{ connected: true, source: "iCloud" | "Google Calendar" | "Outlook", ok, checkedAt, readAt, times, error }`.
  The link itself is never sent back: it opens her whole calendar.
- **The feed**, `GET /calendar/<48 hex>.ics` (also `HEAD`): an iCalendar file of
  confirmed bookings and time off from 60 days ago to 400 days ahead, in UTC,
  whole days as dates. A booking's title is its service and client; its notes
  hold the phone number and ref. `text/calendar`, `Cache-Control: no-store`,
  `X-Robots-Tag: noindex`. The token is compared in constant time; any other
  is 404. Each fetch records `seenAt` (at most every 10 minutes), so the admin
  page can tell her calendar app is collecting it.
- **Her calendar's link** must be `https:` (or `webcal:`, read as `https:`) on
  `pNN-caldav.icloud.com`, `pNN-calendars.icloud.com`, `calendar.google.com` or
  `outlook.live.com` / `outlook.office365.com` / `outlook.office.com`, with no
  credentials or port, at most 2000 characters; anything else is 400 `invalid`
  (`field: "url"`). Redirects are followed by hand, at most 3, each to one of
  those hosts. A calendar that can't be read (unreachable, an error answer, not
  a calendar, over 3 MB, over 20 seconds) is 422 with a message to show.
- **Reading it**: the cron trigger runs every 15 minutes and reads the linked
  calendar. It sends back the last `ETag`/`Last-Modified`; a 304, or a file
  with the same SHA-256 as last time, is not worked out again. Otherwise the
  file is scanned in one pass for `VEVENT` start, end, duration, repeat rule
  (`DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY` with `INTERVAL`, `COUNT`, `UNTIL`,
  `BYDAY`, `BYMONTHDAY`, `BYMONTH`), `EXDATE`, `RECURRENCE-ID`, `STATUS` and
  `TRANSP`; nothing else in it is read. Cancelled and Free events are skipped.
  Time zones are converted with `Intl`; unknown ones are read as SAST.
- **Stored** in `settings`: `calendar_busy` (`{ date: [[startMinute, endMinute]] }`
  in SAST, from yesterday to 400 days ahead), `calendar_import_url`,
  `calendar_import_status`, `calendar_feed_token`, `calendar_feed_seen`. A
  failed read keeps the last busy times and records the error.
- Busy times count everywhere a booking does: `GET /api/availability`, the
  overlap check in `POST /api/bookings` (409 `taken`), and the admin overlap
  check.

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
| `POST /api/admin/login`, `POST /api/admin/setup` | 5 per 15 minutes (shared) | 30 failed logins or setup codes an hour |
| Other `/api/admin/*` | 300 a minute | |
| `POST /api/admin/push/test` | 10 an hour | |
| Website tab edits (services, text, photo descriptions and order, deletes) | 300 an hour | |
| `POST /api/admin/site/photos` | 60 an hour | |
| Phone calendar changes (`feed-reset`, `import`, `sync`, unlinking) | 30 an hour | |
| `GET /calendar/<token>.ics`, wrong tokens included | 120 an hour | |

## Security headers

On every response (pages, files and API):

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'; manifest-src 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
Cross-Origin-Opener-Policy: same-origin
```

Over HTTPS also `Strict-Transport-Security: max-age=31536000` and
`upgrade-insecure-requests` in the CSP. `/admin/` and `/api/` also get
`X-Robots-Tag: noindex, nofollow`, and `/admin/` gets `Cache-Control: no-store`.
`/img/` and `/fonts/` are cached for a week.

`http://` and `www.` addresses answer `301` to the same path on
`https://ohmyglam.online` (in one step), except the calendar feed, which also
answers on `http://` because iPhones fetch `webcal://` links that way. Local
development (`localhost`, `127.0.0.1`) is never redirected. `/404` and
`/404.html` answer `404`, like any unknown address. The pages are `/`,
`/makeup`, `/hair` and `/bridal`; with a trailing slash they answer `301` to the
address without it, and `/book` answers `301` to `/#book` (the booking
calendar).

`script-src 'self'` means no inline scripts and no inline event handlers:
every script is a file under `public/js/`. The JSON-LD block is data, not a
script, so it is unaffected.

## Keeping personal data short-lived

The cron trigger (`[triggers]` in `wrangler.toml`) runs every 15 minutes to
read OMG's calendar; its 01:00 UTC run (03:00 SAST) also deletes:

- pending requests whose date has passed or that are over 30 days old;
- confirmed requests, and the client details on their blocks, 30 days after the appointment;
- blocks more than 180 days in the past;
- expired sessions and rate-limit counters.
