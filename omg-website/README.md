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

Plain HTML and CSS, no build step and no JavaScript. Every booking button opens
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
| `img/logo.webp`, `img/logo@2x.webp`, `img/logo.png` | The OMG logo, cut out of the poster onto a transparent background |
| `img/gallery/glam-*.webp` | Five looks supplied by OMG, 720px wide, each with a 360px copy for phones. `glam-1` to `glam-3` are used exactly as OMG cropped them |
| `og.jpg` | 1200×630 link-preview card |
| `favicon.png`, `apple-touch-icon.png`, `img/icon-*.png` | The swirled "O" from the logo |
| `img/contours.svg` | The swirled background pattern, redrawn as vector |

The logo and icons were cut from a 702×713 photo of the poster, so they are
soft at large sizes. Swap in the original logo file whenever it is available.

The gallery photos are different shapes, so the grid is laid out by hand: each
cell is sized to its photo's own proportions and nothing is trimmed. Swapping a
photo for one of the same shape needs no code change. A photo of a different
shape, or adding or removing one, means updating the row and column sizes in
the `.grid` rules in `index.html`; the comment there explains how they work.
