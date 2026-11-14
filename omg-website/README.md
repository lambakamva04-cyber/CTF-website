# OMG – Oh! My Glam

Single-page site for OMG – Oh! My Glam (makeup and hair). The prices, the fine
print and the contact details come from the 2026 price-list poster.

Two hair services have been renamed since the poster was printed, at the
same prices: "Installation" is now **Basic Installation** (R400) and "Styling
Long Weave" is now **Curling Long Weave** (R450). The poster is no longer
offered as a download for that reason.

The **Bridal** section is not on the poster. Its prices come from OMG's 2026
bridal price list: the Bridal Package (R4500), the two makeup-and-leave options
(R1800 and R2900), bridal natural hairstyles (R850), the optional trial (R750)
and bridesmaid full glam (R850 with strip lashes, R950 with cut crease). Return
transport and accommodation to the bride's location are excluded.

Plain HTML and CSS with no build step. The only script is a short one written
into the page, which runs the gallery's tabs and swipe. Every booking button opens
WhatsApp (+27 78 576 7604) with a message already filled in for that service,
so the enquiry arrives with the service, price, date, time and home-call details
in one go. The bridal buttons ask for the wedding date, the venue and the
number of bridesmaids instead.

## Deploy

From the repo root:

```bash
npm install
npm run deploy:omg
```

The first deploy creates the `omg-oh-my-glam` Worker on a `*.workers.dev` URL.
Attach OMG's own domain to it in the Cloudflare dashboard (Workers >
omg-oh-my-glam > Settings > Domains & Routes).

Preview locally with any static server, for example:

```bash
cd omg-website/public && python3 -m http.server 8080
```

## After the domain is live

- **Share preview.** Change `og:image` in `public/index.html` to the full URL,
  e.g. `https://your-domain/og.jpg`. WhatsApp, Facebook and Instagram only show
  the preview card for absolute image URLs.
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
