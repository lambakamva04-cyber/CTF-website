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
requests. Once OMG links her phone's calendar (below), the times that are busy
in it are blocked too, so nobody can book a time she has already given away.
The calendar shows only busy time ranges: never names, numbers, services or
notes. If saving fails, the page still offers the WhatsApp
message, so a booking is never lost.

## The admin page

Open `/admin/` and sign in with the admin password. It is made for a phone.

**Setting or resetting the password.** The password is set on the admin page
itself, with a one-time setup code:

1. Whoever runs the site makes a code: `npm run admin:setup-code` (or Claude
   puts one in the database). It is valid for 24 hours and works once.
2. On `/admin/`, tap **Have a setup code?** (it opens by itself while no
   password is set), enter the code and the new password twice.
3. That browser is signed in; every other device is signed out.

Only a PBKDF2 hash of the password is stored. Until a password is set this
way, the `ADMIN_PASSWORD` secret (if any) is used instead.

- **Requests**: pending requests, soonest first, with Call and WhatsApp
  buttons. **Confirm** blocks the time on the calendar; **Decline** removes
  the request. If a time clashes with something already booked, the page says
  so and offers "Confirm anyway".
- **Calendar**: everything booked in a month. Add a booking taken by phone, or
  time off (tick "Whole day" for a day off), and delete entries. Deleting a
  booking also deletes that client's details. Upcoming bookings have a
  **Remind on WhatsApp** button: it opens WhatsApp with a reminder already
  written to the client (name, service, day and time), asking them to confirm.
  Send it the day before to cut no-shows. At the top, **Link your phone's
  calendar** connects it to OMG's own calendar, both ways (below). Times busy
  in her calendar show in the month as "Busy · From your own calendar".
- **Reviews**: new reviews wait here. **Approve** puts one on the site. Approve
  genuine reviews, critical ones included; delete only spam or abuse.
- **Website**: change the site itself, no developer needed. Changes show
  within a few seconds.
  - **Services**: every service on the price lists, by card (Makeup, Hair,
    Bridal package, Bride, Bridesmaid): name, price, how long it takes (the
    booking calendar blocks exactly that long), a small note, the makeup glam
    level, and what the bridal package includes. Add, reorder, hide (untick
    "Shown on the website": off the page and not bookable) or delete.
  - **Photos**: the gallery and the before-and-afters. **Add photos** picks
    from the phone; each is shrunk on the phone to a sharp website size before
    it is sent. Tap a photo to describe it (read out to people who can't see
    it, and used by Google), move it, or delete it.
  - **Contact & text**: the WhatsApp/phone number (every WhatsApp and Call
    link on the site follows it), Instagram, the Facebook page, the welcome
    line, the home-calls note and the bridal note.

Sign-in lasts 14 days on a device. Log out on shared devices.

### Phone alerts

The card at the top of **Requests** turns on an alert for every new booking
request and review, on the device it is opened on. Tap **Turn on alerts**,
allow notifications, then **Send a test**.

- **iPhone**: Apple only allows alerts for home-screen apps. Open `/admin/` in
  Safari, tap Share > **Add to Home Screen**, open **OMG Admin** from the home
  screen, sign in and turn alerts on there.
- **Android, computers**: works straight from Chrome, Edge, Firefox or Safari.

Turn alerts on on every device OMG uses (up to 10). The alert says who, what
and when ("New booking request: Thandi · Full Glam · Sat 12 Dec at 09:00");
tapping it opens the admin page. Nothing about the client travels through
Google's or Apple's push service: the push is empty, and the phone fetches the
details from the site with OMG's sign-in.

### Your phone's calendar

On the **Calendar** tab, open **Link your phone's calendar**. It works both
ways, and each half can be used alone:

- **Website bookings in your calendar.** Confirmed bookings and time off
  appear in her calendar next to her other appointments, with the client's
  name, service, number and ref. Each device shows only the buttons that work
  on it:
  - **iPhone:** **Add to iPhone Calendar**, then **Subscribe**.
  - **Mac:** **Add to Apple Calendar** or **Add to Google Calendar**.
  - **Windows or another computer:** **Add to Google Calendar**, or **Copy
    link** for Outlook (Add calendar > Subscribe from web).
  - **Android phone:** Android can't subscribe to a calendar link itself, so
    it offers **Copy link** and **Share link**. Open the admin on the iPhone
    to add it there, or add the link to Google Calendar on a computer.

  The link is private: anyone who has it can see the bookings, so **Make a
  new link** if it is ever shared by mistake (the old one stops working at
  once).
- **Your other appointments on the website.** Paste her own calendar's private
  link and tap **Link my calendar**. On iPhone: Calendar > Calendars > ⓘ next
  to her calendar > **Public Calendar** on > **Share Link** > Copy. (Google:
  Settings > the calendar > *Secret address in iCal format*.) From then on
  every busy time in that calendar is blocked on the website: on the public
  calendar, in the booking checks, and as a clash warning when she confirms a
  request or adds a booking. Events marked Free don't block anything.

The site reads her calendar every 15 minutes. Only the times are kept, never
what the appointments are. If a read fails, the last busy times stay in force
and the card says what went wrong. Only iCloud, Google Calendar and Outlook
links are accepted.

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
4. deploys the site (to its Custom Domain; see below);
5. asks for the admin password (at least 12 characters, hidden as you type).
   This is the only login, so keep it somewhere safe;
6. checks that the live site answers, and prints its address and the admin
   page's.

The site lives at **https://ohmyglam.online**, a Custom Domain attached in
the Cloudflare dashboard (Workers & Pages > omg-oh-my-glam > Domains). The code
follows whichever domain serves it, so nothing in it names the domain.
`workers_dev = false` and `preview_urls = false` in `wrangler.toml` keep the
account's `workers.dev` address (which carries the CTF name) switched off, and
`www.ohmyglam.online` and `http://` forward to `https://ohmyglam.online` in one
redirect. The calendar feed is the one exception to the https redirect: an
iPhone turns the `webcal://` link into `http://`, and a calendar app that
doesn't follow the redirect would stop showing bookings.

Two dashboard settings go with that:

- **Leave "Always Use HTTPS" off** (ohmyglam.online > SSL/TLS > Edge
  Certificates). The Worker already sends http:// to https://; Cloudflare's
  switch would do it before the Worker runs, the calendar feed included.
- **Attach `www.ohmyglam.online` as a second Custom Domain** (Workers & Pages >
  omg-oh-my-glam > Settings > Domains & Routes), so www addresses reach the
  Worker and forward to the bare domain instead of not answering.

## The pages

Both pages are made from `public/index.html`: an element marked
`data-only="home"` or `data-only="bridal"` appears on that page alone (`PAGES`
and `pageShell()` in `src/content.js`), so the header, footer, styles, gallery,
reviews and booking calendar are written once.

| Address | What it has |
| --- | --- |
| `/` | Asanda's makeup and hair prices, a bridal card linking to `/bridal`, the gallery, reviews and the booking calendar |
| `/bridal` | The bridal prices (package, bride, bridesmaids), the gallery, reviews and the booking calendar, with its own title and H1 for searches like "bridal makeup in …". "Book the package" opens the calendar right there |
| `/book` | A short link for an Instagram bio or WhatsApp status: opens the home page at the booking calendar |

Booking stays on every page rather than on a page of its own: each extra
click between "I want this" and "booked" loses clients.

## Google and AI assistants

The site gives search engines and AI assistants everything they read:

| Address | What it is |
| --- | --- |
| `/sitemap.xml` | The two pages Google should index: `/` and `/bridal` |
| `/robots.txt` | Everything public may be crawled (AI assistants included); `/api/` is off limits except the reviews the page shows |
| `/llms.txt` | The price list and how to book, in plain text for AI assistants, built from the same content as the page |
| Each page | Its own canonical address, a title and description written from the Website tab's prices, one H1, and the business's details as schema.org data (Asanda as the founder) |

**The area OMG works in** (Website tab > Contact & text > Area you work in,
e.g. "Soweto, Johannesburg") goes into Google's title, the description, the H1,
the schema.org address and the AI summary. Until it is set, the site names no
place, and searches like "makeup artist in Soweto" can't find it.

**Search Console (one time).** At https://search.google.com/search-console add
a **Domain** property for `ohmyglam.online`. Google recognises Cloudflare and
offers to add its DNS record for you (otherwise copy the TXT record it shows into
Cloudflare > DNS > Records): no file to upload. Then, under
Sitemaps, submit `https://ohmyglam.online/sitemap.xml`, and use URL inspection
> Request indexing on `https://ohmyglam.online/`. Bing Webmaster Tools can import
the property from Search Console in one step; Bing feeds Copilot and ChatGPT
search.

**AI crawlers.** New Cloudflare domains allow AI crawlers. To check, in the
Cloudflare dashboard open ohmyglam.online > Security > Settings > AI Crawler and
Agent access policies: Search and Agents should say Allow (and Training too,
if OMG is happy for AI models to learn from the site).

## Deploy changes

The live site deploys itself: the `omg-oh-my-glam` Worker is connected to this
repository in Cloudflare (Workers & Pages > omg-oh-my-glam > Settings > Build,
root directory `omg-website`), so every merge to `main` goes live within a
couple of minutes. There is no separate test site, so review before merging.

**A new file in `migrations/` must reach the live database before the code
that needs it is merged.** Cloudflare's build does not run migrations. From a
computer signed in to Cloudflare:

```bash
npm run db:migrate
```

Write migrations so the old code still works with them (add tables and
columns, widen checks), then that order is always safe.

To deploy by hand instead: `npm run deploy` here, or `npm run deploy:omg` from
the repo root. It refuses to run, and says why, until the database id is in
`wrangler.toml`.

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

## How the editable content works

Services, photos, contact details and texts live in the database (migration
`0004_site_content.sql` added them, seeded with what the site showed before).
Uploaded photos are stored in the `omg-oh-my-glam-media` KV namespace (binding
`MEDIA`; R2 would need a payment card on the account) and served at
`/media/...`. The Worker writes the content into the home page as it is served
(`src/content.js`): the price lists, the bridal package, both photo albums, the
contact links, the page description, Google's listing data and the booking
calendar's list of services all come from the same rows the booking checks use.
Everything typed on the admin page is escaped, so it always shows as text.

`public/index.html` still contains the starting content, so if the database
could not be read the page would still be complete. The opening hours, the
30-minute grid of start times, the 3 hours' minimum notice and how far ahead
clients can book are rules, not content: they are in `public/js/catalog.js`.

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
- **Calendar links**: the site only ever fetches calendars from iCloud,
  Google Calendar or Outlook (redirects included), so a pasted link can't make
  it reach anywhere else. The bookings feed sits behind a random 192-bit link,
  is rate limited, and can be replaced at any time.
- Bodies are capped at 8 KB. Errors never reveal internals. Every response,
  pages included, carries the security headers listed in API.md.

## Personal data

A daily job (03:00 in South Africa) deletes requests nobody confirmed, client
details 30 days after the appointment, calendar entries older than 180 days,
and expired sessions and counters. The booking form tells clients their
details are deleted within 30 days after the appointment. From OMG's own
calendar the site keeps busy times only: no titles, places, notes or guests.

## Tests

```bash
npm test              # unit tests: validation, slot maths, headers
bash e2e/run.sh       # ~420 black-box security checks against a local Worker
```

`e2e/run.sh` starts a throwaway Worker on a fresh local database, so it never
touches real data. GitHub runs both on every push.

## Still to supply

- **Link OMG's phone calendar** (Calendar tab > Link your phone's calendar),
  both ways. Until her own calendar is linked, the website can't see the
  appointments she takes by phone or WhatsApp.

- **Service durations.** The starting times are estimates. Set each service's
  real length on the Website tab, or the calendar will book clients too close
  together (or too far apart).
- **Facebook link.** The site shows no Facebook link until her page's real
  link is set on the Website tab (Contact & text). Until then there is no
  placeholder: a Facebook search is not her page.
- **Area you work in.** Website tab > Contact & text. Google and AI assistants
  only find the site for searches with a place in them once it is set (see
  Google and AI assistants above).

## Images

| File | What it is |
| --- | --- |
| `img/logo-240.webp`, `img/logo.webp`, `img/logo-840.webp` | The OMG logo at three widths (240, 560 and 840px), WebP at quality 80 (alpha 80; lower bands the glow). It is OMG's own logo artwork, cut out of its brown satin background so it sits on any of the site's backgrounds. The masters they are made from are in `brand/` (`logo-1120.webp`, `logo-560.png`), outside the website |
| `img/gallery/glam-*.webp` | The five starting looks supplied by OMG, 720px wide, each with a 360px copy for phones. Photos added on the Website tab are stored in KV instead |
| `img/before-after/ba-*.webp` | The five starting before-and-after pictures supplied by OMG, used whole. 720px wide, each with a larger `-lg` copy for sharp phone screens |
| `og.jpg` | 1200×630 link-preview card. It names no prices or number, so it stays true whatever is changed on the Website tab |
| `favicon.png`, `apple-touch-icon.png`, `img/icon-*.png` | The swirled "O" from the logo |
| `img/contours.svg` | The swirled background pattern, redrawn as vector. It is the largest thing on a phone's first screen, so the page preloads it |
| `fonts/*.woff2` | Montserrat, Cormorant Garamond and Great Vibes (Google Fonts, SIL Open Font License), latin characters, served from the site itself so the page waits for no other server |

The logo and icons come from the logo artwork OMG supplied (1362×768). The
top bar and footer load the smallest file; the big logo at the top of the page
picks a width to suit the screen, at most 840px (sharp on any phone, and half
the weight of a 1120px copy). To remake them from the master:

```bash
node -e "const s=require('sharp');for(const[w,n]of[[840,'logo-840'],[560,'logo'],[240,'logo-240']])s('brand/logo-1120.webp').resize({width:w}).webp({quality:80,alphaQuality:80,effort:6,smartSubsample:true}).toFile('public/img/'+n+'.webp')"
```

Photos added on the Website tab are shrunk on the phone before upload to the
size each album shows them: Photos 720px (360px copy), Before & after 1080px
(720px copy).

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

**Photos.** Two columns on phones and three on wider screens, each photo at
its own shape, nothing trimmed, so any number and mix of shapes lays out well.
Add, remove, reorder and describe them on the admin page's Website tab.

**Before & after.** One picture per row on phones, two and then three across on
wider screens. Also managed on the Website tab. A slide with no photos is
hidden.

**Videos.** The slide is built but commented out in `index.html` while there
are no videos, so visitors (and Google) never meet an empty slide. With the
first video, remove the comment marks around the Videos panel; its tab then
appears on its own. For each video:

1. Put the video in `public/video/` as an MP4 (H.264), with a still image of
   the same name as its cover, e.g. `soft-glam.mp4` and `soft-glam.jpg`.
   Cloudflare will not serve a file over 25 MB, so keep each video under that.
2. Add a line to the `video-grid` list in `index.html`, following the commented
   example there, with the video's real width and height.

Nothing is downloaded until a visitor presses play, and only one video plays
at a time.
