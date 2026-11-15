# OMG – Oh! My Glam

Single-page site for OMG – Oh! My Glam (makeup and hair). The prices, the fine
print and the contact details come from OMG's price-list poster. The prices
are not tied to a year, so the site never says one.

Two hair services have been renamed since the poster was printed, at the
same prices: "Installation" is now **Basic Installation** (R400) and "Styling
Long Weave" is now **Curling Long Weave** (R450). The poster is no longer
offered as a download for that reason.

The **Bridal** section is not on the poster. Its prices come from OMG's bridal
price list: the Bridal Package (R4500), the two makeup-and-leave options
(R1800 and R2900), bridal natural hairstyles (R850), the optional trial (R750)
and bridesmaid full glam (R850 with strip lashes, R950 with cut crease). Return
transport and accommodation to the bride's location are excluded.

The site is static pages plus a small Cloudflare Worker (`src/`) with a D1
database. The Worker runs the **booking calendar**, the **reviews** and the
**admin page** at `/admin/`. The full API is in [API.md](API.md).

## How booking works

1. A client picks a service, a day and a free start time on the calendar.
   Every "Book" button on the price lists opens the calendar with that
   service already chosen.
2. They enter their **Name and Surname** and **Contact Number** and tap
   "Request this time". The request is saved as *pending* and they get a
   button that opens WhatsApp with this message ready to send:

   ```
   Name and Surname: Thandi Mokoena
   Contact Number: 082 123 4567
   Service: Full Glam (R850)
   Date and Time: Saturday 12 December 2026 at 09:00
   Ref: OMG-7K2P
   ```

3. OMG confirms it on the admin page with one tap. Only then does the time
   show as booked on the calendar.

Pending requests never block the calendar, so nobody can fill it with fake
requests. The calendar shows only booked time ranges: never names, numbers,
services or notes. If saving fails, the page still offers the WhatsApp
message, so a booking is never lost.

## The admin page

Open `/admin/` and sign in with the admin password. It is made for a phone.

- **Requests**: pending requests, soonest first, with Call and WhatsApp
  buttons. **Confirm** blocks the time on the calendar; **Decline** removes
  the request. If a time clashes with something already booked, the page says
  so and offers "Confirm anyway".
- **Calendar**: everything booked in a month. Add a booking taken by phone, or
  time off (tick "Whole day" for a day off), and delete entries. Deleting a
  booking also deletes that client's details.
- **Reviews**: new reviews wait here. **Approve** puts one on the site. Approve
  genuine reviews, critical ones included; delete only spam or abuse.

Sign-in lasts 14 days on a device. Log out on shared devices.

## Go live (one time)

Needs Node.js 22 and a free Cloudflare account. From this folder:

```bash
npm install
npm run setup
```

`npm run setup` (or `npm run setup:omg` from the repo root) does the whole
first launch and is safe to run again:

1. signs in to Cloudflare (opens the browser the first time);
2. creates the `omg-oh-my-glam` database and writes its id into
   `wrangler.toml`. **Commit that change**, so later deploys use it;
3. creates the tables;
4. deploys the site to a `*.workers.dev` address;
5. asks for the admin password (at least 12 characters, hidden as you type).
   This is the only login, so keep it somewhere safe;
6. checks that the live site answers, and prints its address and the admin
   page's.

To use OMG's own domain, attach it in the Cloudflare dashboard (Workers &
Pages > omg-oh-my-glam > Settings > Domains & Routes). Nothing in the code
needs to change: the link-preview image follows whichever domain served the
page.

## Deploy changes

```bash
npm run deploy            # from this folder
npm run deploy:omg        # or from the repo root
```

Run `npm run db:migrate` first whenever a new file appears in `migrations/`.
`npm run deploy` refuses to run, and says why, until `npm run setup` has been
done once.

## Backups

D1 keeps a rolling history of the database (Time Travel), so it can be put
back to any minute in the last 30 days (7 on the free plan):

```bash
npx wrangler d1 time-travel info omg-oh-my-glam                                 # current restore point
npx wrangler d1 time-travel restore omg-oh-my-glam --timestamp=2026-12-01T09:00:00+02:00
npx wrangler d1 export omg-oh-my-glam --remote --output backup.sql             # a copy to keep
```

A copy made with `export` holds clients' names and numbers: keep it private
and delete it when it is no longer needed.

## Run it locally

```bash
cp .dev.vars.example .dev.vars     # then set a local ADMIN_PASSWORD
npm run db:migrate:local
npm run dev                        # http://localhost:8787
```

## Change prices, durations or opening hours

Everything bookable is in `public/js/catalog.js`: the services with their
prices and how long each takes, the opening hours, the 30-minute grid of start
times, the 3 hours' minimum notice and how far ahead clients can book. The page
and the Worker both read this one file, so a change there is a change
everywhere. **The durations are estimates: set them to the real times.**

## Security

- **SQL injection**: every query uses bound parameters; no request value is
  ever put into SQL text. Inputs are checked against fixed formats and lists
  before they reach the database.
- **Rate limits** on every API route, per visitor and site-wide (the table is
  in API.md). Visitors are identified by a salted hash of their IP; raw IPs are
  never stored.
- **Cross-site requests**: every state-changing request must come from the
  site itself (`Origin` check) and be JSON. The admin cookie is `__Host-`,
  `Secure`, `HttpOnly` and `SameSite=Strict`.
- **Script injection**: a strict Content-Security-Policy allows scripts only
  from the site's own files; names and reviews are always shown as text.
- **Admin**: constant-time password check, 5 tries per 15 minutes per address,
  and sign-in pauses for everyone after 30 wrong passwords in an hour. Session
  tokens are random and stored only as hashes.
- **Bots**: a hidden honeypot field and a minimum fill time. Bots get a reply
  that looks normal, and nothing is stored.
- Bodies are capped at 8 KB. Errors never reveal internals. Every response,
  pages included, carries the security headers listed in API.md.

## Personal data

A daily job deletes requests nobody confirmed, client details 30 days after
the appointment, calendar entries older than 180 days, and expired sessions
and counters. The booking form tells clients their details are deleted within
30 days after the appointment.

## Tests

```bash
npm test              # unit tests: validation, slot maths, headers
bash e2e/run.sh       # ~310 black-box security checks against a local Worker
```

`e2e/run.sh` starts a throwaway Worker on a fresh local database, so it never
touches real data. GitHub runs both on every push.

## Still to supply

- **Service durations.** The times in `public/js/catalog.js` are estimates.
  Set them to how long each service really takes, or the calendar will book
  clients too close together (or too far apart).
- **Facebook link.** The poster gives only the name "Asanda Tiwani", so the
  Facebook link is a search for that name. Replace it with the page's real URL.

## Images

| File | What it is |
| --- | --- |
| `img/logo-240.webp`, `img/logo.webp`, `img/logo-840.webp`, `img/logo@2x.webp`, `img/logo.png` | The OMG logo at four widths (240, 560, 840 and 1120px) plus a PNG copy. It is OMG's own logo artwork, cut out of its brown satin background so it sits on any of the site's backgrounds |
| `img/gallery/glam-*.webp` | Five looks supplied by OMG, 720px wide, each with a 360px copy for phones. `glam-1` to `glam-3` are used exactly as OMG cropped them |
| `img/before-after/ba-*.webp` | Five before-and-after pictures supplied by OMG, used whole. 720px wide, each with a larger `-lg` copy for sharp phone screens |
| `og.jpg` | 1200×630 link-preview card |
| `favicon.png`, `apple-touch-icon.png`, `img/icon-*.png` | The swirled "O" from the logo |
| `img/contours.svg` | The swirled background pattern, redrawn as vector |

The logo and icons come from the logo artwork OMG supplied (1362×768). The
top bar and footer load the smallest file; the big logo at the top of the page
picks a width to suit the screen.

## The logo's sparkles

The big logo at the top of the page has moving sparkles. They are plain CSS,
with no script and no extra files:

- Thirteen sit exactly on the sparkles painted into the logo and flare in
  turn, so those sparkles appear to twinkle.
- Three more travel around the outline of the OMG letters.

Every position is measured as a share of the logo's width, so the sparkles
stay in place at any screen size. Visitors who have asked their device for
reduced motion see the logo without the animation. If the logo artwork is ever
replaced, the positions in the `glints` block of `index.html` need redoing to
match the new artwork.

## The glam: photos, before & after, videos

"the glam" is three slides. Visitors move between them with the tabs, with the
buttons at the foot of each slide, or by swiping sideways on a phone. A link
ending in `#before-after` (or `#photos`, `#videos`) opens that slide directly,
which is useful for a WhatsApp status or an Instagram bio.

With scripts switched off the three slides simply stack, each under its own
heading, so nothing is ever hidden.

**Photos.** The photos are different shapes, so this grid is laid out by hand:
each cell is sized to its photo's own proportions and nothing is trimmed.
Swapping a photo for one of the same shape needs no code change. A photo of a
different shape, or adding or removing one, means updating the row and column
sizes in the `.grid` rules in `index.html`; the comment there explains how they
work.

**Before & after.** An ordinary grid: one picture per row on phones, two and
then three across on wider screens. To add one, copy an `<li>` in the
`ba-grid` list and point it at the new files.

**Videos.** The slide and its tab are built but stay hidden while the list is
empty, so visitors never land on an empty tab. Adding the first video switches
them on. For each video:

1. Put the video in `public/video/` as an MP4 (H.264), with a still image of
   the same name as its cover, e.g. `soft-glam.mp4` and `soft-glam.jpg`.
   Cloudflare will not serve a file over 25 MB, so keep each video under that.
2. Add a line to the `video-grid` list in `index.html`, following the commented
   example there, with the video's real width and height.

Nothing is downloaded until a visitor presses play, and only one video plays
at a time.
