# OMG – Oh! My Glam

Single-page site for OMG – Oh! My Glam (makeup and hair). Every price, the
fine print and the contact details come straight from the 2026 price-list
poster, which is also published at `/omg-2026-price-list.jpg` so clients can
save and forward it.

Plain HTML and CSS, no build step and no JavaScript. Every booking button opens
WhatsApp (+27 78 576 7604) with a message already filled in for that service,
so the enquiry arrives with the service, price, date, time and home-call details
in one go.

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
| `img/gallery/*.webp` | The seven looks from the poster, cropped out of their frames |
| `og.jpg` | 1200×630 link-preview card |
| `favicon.png`, `apple-touch-icon.png`, `img/icon-*.png` | The swirled "O" from the logo |
| `img/contours.svg` | The swirled background pattern, redrawn as vector |

Everything was cut from a 702×713 photo of the poster, so the gallery photos
are soft. Swap in the original photos (same file names, roughly square, 800px or
more) and the original logo file whenever they are available. No code changes
are needed.
