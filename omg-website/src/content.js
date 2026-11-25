// The website's editable content: the services and prices, the photos, the
// contact details and a few lines of text. OMG changes them on the admin
// page's Website tab. The Worker writes them into the page as it is served,
// so the price lists, the booking calendar, the WhatsApp links and the data
// Google reads always agree, and no change needs a developer.
//
// Everything typed on the admin page reaches the public page escaped (esc()
// for HTML, safeJson() for the JSON blocks), so it is always shown as text.

import { GROUP_OF_CARD, SERVICE_GROUPS, UTC_OFFSET_MINUTES, WHATSAPP_NUMBER, formatMonth } from '../public/js/catalog.js';
import { nowInZone } from '../public/js/slots.js';
import { guard } from './admin.js';
import { HttpError, invalid, json, notFound, readJson, unreadable } from './http.js';
import { enforce } from './ratelimit.js';
import { charCount, clean } from './validate.js';

export const CARDS = ['makeup', 'hair', 'package', 'bride', 'bridesmaid'];
export const ALBUMS = ['looks', 'before_after'];
const TEXT_KEYS = ['phone', 'instagram', 'facebook_url', 'facebook_name', 'area', 'tagline', 'home_calls', 'bridal_note'];
/** How long a Worker reuses the content before reading it again. */
const CACHE_MS = 15_000;
/** The makeup artist behind OMG – Oh! My Glam: in full where Google should learn the name. */
export const ARTIST = 'Asanda Tiwani';
const FIRST_NAME = 'Asanda';
const SITE = 'https://ohmyglam.online';
/**
 * The site's pages, all made from public/index.html: an element marked
 * data-only="…" appears only on the pages it names (pageShell()). Home
 * introduces OMG and Asanda and lists the services; each service has a page
 * of its own, made for the searches people do ("bridal makeup in …").
 */
export const PAGES = {
  home: { path: '/', canonical: `${SITE}/` },
  makeup: { path: '/makeup', canonical: `${SITE}/makeup`, cards: ['makeup'], lede: 'From soft and subtle to bold and dramatic: choose your level of glam, then pick a time. Home calls on request.', pricesTitle: 'Makeup Prices', pricesNote: 'Pick your level of glam, then tap Book to choose a time.' },
  hair: { path: '/hair', canonical: `${SITE}/hair`, cards: ['hair'], lede: 'Weave installation and curling, on its own or with your makeup. Home calls on request.', pricesTitle: 'Hair Prices', pricesNote: 'Tap Book on a service to choose a time.' },
  bridal: { path: '/bridal', canonical: `${SITE}/bridal`, cards: ['package', 'bride', 'bridesmaid'], lede: 'Hair and makeup for your wedding day, for the bride and the whole bridal party. Home calls on request.' },
};
const REVIEWS_PAGE = 6; // as src/reviews.js
const MAX_SERVICES = 60;
const MAX_PHOTOS = 40; // per album
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
const MAX_LARGE_BYTES = 3 * 1024 * 1024;
const MAX_SMALL_BYTES = 1024 * 1024;
const MEDIA_KEY = /^[a-f0-9]{32}-[ls]\.(?:webp|jpg)$/;
const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

// ---------------------------------------------------------------- text helpers

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Text made safe for HTML, both between tags and inside attributes. */
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** JSON that is safe inside a <script> element: nothing in it can close the tag. */
export function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** "27785767604" → "+27 78 576 7604"; other countries as +digits. */
export function formatPhone(digits) {
  const d = String(digits ?? '');
  return /^27\d{9}$/.test(d) ? `+27 ${d.slice(2, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : `+${d}`;
}

const waHref = (phone, text) => `https://wa.me/${phone}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
const instagramUrl = (handle) => (handle ? `https://www.instagram.com/${handle}/` : '');
/** Only paths the Worker itself wrote: shipped images or uploaded ones. */
const safeSrc = (path) => (/^\/(?:img|media)(?:\/[\w@][\w@.-]*)+$/.test(path) ? path : '/img/logo.webp');

/**
 * The bridal package's "what's included" text: one item per line, and a line
 * ending in ":" starts a heading ("Makeup:").
 */
export function detailGroups(details) {
  const groups = [];
  for (const raw of String(details ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length > 1 && line.endsWith(':')) {
      groups.push({ heading: line.slice(0, -1).trim(), items: [] });
    } else {
      if (!groups.length) groups.push({ heading: '', items: [] });
      groups[groups.length - 1].items.push(line);
    }
  }
  return groups.filter((g) => g.items.length);
}

// ---------------------------------------------------------------- validation

function textField(value, field, { min, max, multiline = false, message }) {
  const text = clean(typeof value === 'string' ? value : '', { multiline });
  const n = charCount(text);
  if (n < min || n > max) throw invalid(field, message);
  return text;
}

function optionalText(value, field, max, message, multiline = false) {
  if (value === null || value === undefined) return null;
  const text = textField(value, field, { min: 0, max, multiline, message });
  return text || null;
}

function wholeNumber(value, field, min, max, message) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(field, message);
  return value;
}

/** A phone number as WhatsApp wants it: country code and digits, no plus. */
export function phoneDigits(value) {
  const message = 'Enter the WhatsApp number, e.g. 078 576 7604 or +27 78 576 7604.';
  const raw = typeof value === 'string' ? value.trim() : '';
  const compact = raw.replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(compact)) throw invalid('phone', message);
  let digits = compact.replace('+', '');
  if (!compact.startsWith('+')) {
    if (/^0\d{9}$/.test(digits)) digits = `27${digits.slice(1)}`;
    else if (digits.startsWith('00')) digits = digits.slice(2);
  }
  if (!/^[1-9]\d{8,14}$/.test(digits)) throw invalid('phone', message);
  return digits;
}

/** An Instagram username from "@name", "name" or a profile link. Empty clears it. */
export function instagramHandle(value) {
  let text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  const link = /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?$/i.exec(text);
  text = link ? link[1] : text.replace(/^@/, '');
  if (!/^[A-Za-z0-9._]{1,30}$/.test(text)) throw invalid('instagram', 'Enter the Instagram username, e.g. @asanda_tiwani.');
  return text;
}

const FACEBOOK_HOSTS = /^(?:(?:www|m|web)\.)?facebook\.com$|^fb\.com$|^fb\.me$/i;
/** A link to a Facebook page. Empty clears it. */
export function facebookUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  const message = 'Paste the link to the Facebook page, e.g. https://www.facebook.com/yourpage.';
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw invalid('facebook_url', message);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port || !FACEBOOK_HOSTS.test(url.hostname)) {
    throw invalid('facebook_url', message);
  }
  url.protocol = 'https:';
  if (url.href.length > 300) throw invalid('facebook_url', message);
  return url.href;
}

/** A service as typed on the admin page, checked field by field. */
export function serviceInput(body) {
  const card = body.card;
  if (!CARDS.includes(card)) throw invalid('card', 'Choose where the service is listed.');
  const name = textField(body.name, 'name', { min: 2, max: 60, message: 'Give the service a name (2 to 60 characters).' });
  const price = wholeNumber(body.price, 'price', 0, 100000, 'Enter the price in rand, as a whole number.');
  const minutes = wholeNumber(body.minutes, 'minutes', 15, 720, 'Choose how long it takes: 15 minutes to 12 hours.');
  if (minutes % 15) throw invalid('minutes', 'Choose how long it takes, in steps of 15 minutes.');
  const note = optionalText(body.note, 'note', 60, 'Keep the note to 60 characters.');
  let level = null;
  if (card === 'makeup' && body.level !== null && body.level !== undefined && body.level !== 0) {
    level = wholeNumber(body.level, 'level', 1, 3, 'Choose a glam level from 1 to 3, or none.');
  }
  let details = null;
  if (card === 'package') {
    details = optionalText(body.details, 'details', 1000, "Keep what's included to 1000 characters.", true);
    if (details && details.split('\n').length > 30) throw invalid('details', "Keep what's included to 30 lines.");
  }
  if (typeof body.visible !== 'boolean') throw invalid('visible', 'Choose whether the service is shown.');
  return { card, name, price, minutes, note, level, details, visible: body.visible ? 1 : 0 };
}

// Google reads this to know what a photo shows, so a camera file name won't do.
const FILE_NAME = /\.(?:jpe?g|png|webp|heic|heif)\b|^(?:img|dsc|pxl|photo|image)[\s_-]?\d+$/i;
export function photoAlt(value) {
  const text = textField(value, 'alt', { min: 3, max: 160, message: 'Describe the photo in a few words (3 to 160 characters).' });
  if (FILE_NAME.test(text)) throw invalid('alt', 'Say what the photo shows (for example "Soft glam with a nude lip"), not its file name.');
  return text;
}

// ---------------------------------------------------------------- loading

const cache = new WeakMap();

/** Everything the page shows, read once per CACHE_MS per Worker. */
export async function loadSite(env) {
  const hit = cache.get(env.DB);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.site;
  const [services, text, photos, stats, reviews] = await env.DB.batch([
    env.DB.prepare('SELECT id, card, name, price, minutes, note, level, details, sort, visible FROM services ORDER BY card, sort, name'),
    env.DB.prepare('SELECT key, value FROM site_text'),
    env.DB.prepare('SELECT id, album, src, src_small, width, height, small_width, alt, sort FROM photos ORDER BY album, sort, id'),
    env.DB.prepare("SELECT COUNT(*) AS count, AVG(rating) AS average FROM reviews WHERE status = 'approved'"),
    env.DB.prepare(`SELECT id, name, rating, comment, created_at FROM reviews WHERE status = 'approved' ORDER BY created_at DESC, id DESC LIMIT ${REVIEWS_PAGE + 1}`),
  ]);
  const count = stats.results[0]?.count ?? 0;
  const site = {
    services: services.results,
    text: Object.fromEntries(text.results.map((r) => [r.key, r.value])),
    photos: photos.results,
    // Page 1 of the approved reviews, as GET /api/reviews?page=1 gives it.
    reviews: {
      count,
      average: count ? Math.round(stats.results[0].average * 100) / 100 : null,
      hasMore: reviews.results.length > REVIEWS_PAGE,
      items: reviews.results.slice(0, REVIEWS_PAGE).map((r) => ({ ...r, date: nowInZone(UTC_OFFSET_MINUTES, r.created_at).date })),
    },
  };
  cache.set(env.DB, { at: Date.now(), site });
  return site;
}

/** After an edit, so the next page this Worker serves shows it. */
export function forgetSite(env) {
  cache.delete(env.DB);
}

/** The service a booking names, if it exists and is shown on the site. */
export async function bookableService(env, id) {
  if (typeof id !== 'string' || !SERVICE_ID.test(id)) return null;
  return env.DB.prepare('SELECT id, card, name, price, minutes FROM services WHERE id = ?1 AND visible = 1').bind(id).first();
}

/** OMG's WhatsApp number as stored, or the original if none is. */
export async function sitePhone(env) {
  const site = await loadSite(env);
  return site.text.phone || WHATSAPP_NUMBER;
}

// ---------------------------------------------------------------- the page

/** The WhatsApp message a "Book" link opens when the booking calendar can't run. */
function bookText(service) {
  const lines = [`Hi OMG! I'd like to book ${service.name} (R${service.price}).`, ''];
  if (service.card === 'makeup' || service.card === 'hair') lines.push('Date:', 'Time:', 'Home call? (yes/no, and your area):');
  else if (service.card === 'bridesmaid') lines.push('Wedding date:', 'Venue / area:', 'Number of bridesmaids:');
  else lines.push('Wedding date:', 'Venue / area:', 'Bridesmaids needing makeup:');
  return lines.join('\n');
}

const ARROW = '<svg class="icon" aria-hidden="true"><use href="#i-arrow"/></svg>';

export function serviceItem(s, phone) {
  const meter = s.level
    ? `<span class="meter" aria-label="Glam level ${s.level} of 3">${[1, 2, 3].map((i) => (i <= s.level ? '<i class="on"></i>' : '<i></i>')).join('')}</span>`
    : '';
  const note = s.note ? `<span class="svc-note">${esc(s.note)}</span>` : '';
  return `<li class="svc"><div class="svc-line"><span class="svc-name">${esc(s.name)}</span><span class="svc-dots" aria-hidden="true"></span>`
    + `<span class="svc-price gold-text">R${s.price}</span></div><div class="svc-meta">${meter}${note}`
    + `<a data-service="${esc(s.id)}" class="svc-book" href="${esc(waHref(phone, bookText(s)))}" target="_blank" rel="noopener" `
    + `aria-label="Book ${esc(s.name)}, R${s.price}">Book ${ARROW}</a></div></li>`;
}

export function packageArticle(s, phone) {
  const groups = detailGroups(s.details);
  const included = groups.length
    ? `<div class="pkg-incl">${groups.map((g) => `<div>${g.heading ? `<h4>${esc(g.heading)}</h4>` : ''}<ul>${g.items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></div>`).join('')}</div>`
    : '';
  const note = s.note ? `<p class="pkg-note">${esc(s.note)}</p>` : '';
  return `<article class="pkg" aria-labelledby="pkg-${esc(s.id)}"><div class="pkg-main"><span class="pkg-tag">For the bride</span>`
    + `<h3 id="pkg-${esc(s.id)}" class="gold-text">${esc(s.name)}</h3><p class="pkg-price gold-text">R${s.price}</p>${note}`
    + `<a data-service="${esc(s.id)}" class="btn btn-gold" href="${esc(waHref(phone, bookText(s)))}" target="_blank" rel="noopener" `
    + `aria-label="Book the ${esc(s.name)}, R${s.price}"><svg class="icon" aria-hidden="true"><use href="#i-wa"/></svg>Book the package</a></div>`
    + `${included}</article>`;
}

const PHOTO_SIZES = {
  looks: '(max-width: 699px) 46vw, 350px',
  before_after: '(max-width: 559px) 92vw, (max-width: 899px) 46vw, 350px',
};
const PHOTO_CTA = {
  looks: `<li class="g-cta"><a class="cta-tile" href="#book"><strong>Your turn.</strong><span>Book your glam ${ARROW}</span></a></li>`,
  before_after: `<li><a class="cta-tile" href="#book"><strong>Ready for your after?</strong><span>Book your glam ${ARROW}</span></a></li>`,
};

export function photoItem(p) {
  const src = safeSrc(p.src);
  const small = safeSrc(p.src_small);
  return `<li><img class="shot" src="${esc(small)}" srcset="${esc(small)} ${p.small_width}w, ${esc(src)} ${p.width}w" `
    + `sizes="${PHOTO_SIZES[p.album]}" width="${p.width}" height="${p.height}" loading="lazy" decoding="async" alt="${esc(p.alt)}"></li>`;
}

/** The HTML inside a price-list card (or the bridal package's place). */
export function listHtml(card, site) {
  const phone = site.text.phone || WHATSAPP_NUMBER;
  const services = visibleServices(site).filter((s) => s.card === card);
  return card === 'package'
    ? services.map((s) => packageArticle(s, phone)).join('')
    : services.map((s) => serviceItem(s, phone)).join('');
}

/** The HTML inside a photo album: its photos, then the booking tile. */
export function photosHtml(album, site) {
  return site.photos.filter((p) => p.album === album).map(photoItem).join('') + PHOTO_CTA[album];
}

function visibleServices(site) {
  const groupOrder = (s) => SERVICE_GROUPS.indexOf(GROUP_OF_CARD[s.card]);
  return site.services
    .filter((s) => s.visible)
    .sort((a, b) => groupOrder(a) - groupOrder(b) || CARDS.indexOf(a.card) - CARDS.indexOf(b.card) || a.sort - b.sort);
}

/** The services the booking calendar offers, and the number it sends to. */
export function catalogJson(site) {
  const services = visibleServices(site).map((s) => ({ id: s.id, group: GROUP_OF_CARD[s.card], name: s.name, price: s.price, minutes: s.minutes }));
  return safeJson({ phone: site.text.phone || WHATSAPP_NUMBER, services });
}

/**
 * What Google and AI assistants read about the business (schema.org JSON-LD),
 * from the same rows as the page. The address names only the area OMG works in
 * (Website tab), never a street: it is a mobile service. Reviews are left out:
 * Google ignores ratings a business shows about itself, and marking them up
 * risks a penalty.
 */
export function jsonLd(site, origin) {
  const home = `${origin}/`;
  const id = `${home}#business`;
  const name = 'OMG – Oh! My Glam';
  const area = areaOf(site);
  const services = visibleServices(site);
  const prices = services.map((s) => s.price);
  const facebook = site.text.facebook_url && !/\/search\b/.test(site.text.facebook_url) ? site.text.facebook_url : '';
  const sameAs = [instagramUrl(site.text.instagram), facebook].filter(Boolean);
  const photos = site.photos.filter((p) => p.album === 'looks').slice(0, 3).map((p) => origin + safeSrc(p.src));
  const offer = (s) => {
    const included = s.card === 'package' ? detailGroups(s.details).map((g) => `${g.heading ? `${g.heading}: ` : ''}${g.items.join(', ')}`) : [];
    const about = [s.note, ...included].filter(Boolean).join('; ');
    return {
      '@type': 'Offer',
      price: String(s.price),
      priceCurrency: 'ZAR',
      itemOffered: { '@type': 'Service', name: s.name, serviceType: GROUP_OF_CARD[s.card], ...(about ? { description: about } : {}) },
    };
  };
  return safeJson({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${home}#website`, url: home, name, alternateName: ['Oh! My Glam', 'OMG'], inLanguage: 'en-ZA', publisher: { '@id': id } },
      {
        '@type': 'Person',
        '@id': `${home}#artist`,
        name: ARTIST,
        jobTitle: 'Makeup artist and hair stylist',
        worksFor: { '@id': id },
        url: home,
        ...(area ? { workLocation: { '@type': 'Place', name: area } } : {}),
        ...(sameAs.length ? { sameAs } : {}),
      },
      {
        '@type': 'HealthAndBeautyBusiness',
        '@id': id,
        name,
        alternateName: ['OMG', 'Oh! My Glam'],
        url: home,
        logo: `${origin}/img/icon-512.png`,
        image: [`${origin}/og.jpg`, ...photos],
        description: `Makeup and hair styling by ${ARTIST}${area ? ` in ${area}` : ''}, including bridal and bridesmaid packages. Home calls on request; transport is quoted separately.`,
        founder: { '@id': `${home}#artist` },
        telephone: `+${site.text.phone || WHATSAPP_NUMBER}`,
        address: { '@type': 'PostalAddress', ...(area ? { addressLocality: area } : {}), addressCountry: 'ZA' },
        ...(area ? { areaServed: area } : {}),
        currenciesAccepted: 'ZAR',
        ...(prices.length ? {
          priceRange: `R${Math.min(...prices)} – R${Math.max(...prices)}`,
          hasOfferCatalog: { '@type': 'OfferCatalog', name: 'Price List', itemListElement: services.map(offer) },
        } : {}),
        ...(sameAs.length ? { sameAs } : {}),
      },
    ],
  });
}

const chars = (text) => [...text].length;
const areaOf = (site) => (site.text.area || '').trim();
/** The lowest price a card shows, or null when it shows nothing. */
function fromPrice(services, card) {
  const prices = services.filter((s) => s.card === card).map((s) => s.price);
  return prices.length ? Math.min(...prices) : null;
}

/** Each page's <title>: what people search, the area, then the name, under 60 characters. */
const TITLES = {
  home: (area) => [area && `Makeup Artist in ${area} – ${ARTIST} | OMG`, area && `Makeup Artist in ${area} – ${ARTIST}`, area && `Makeup Artist in ${area} – OMG`, `${ARTIST} – Makeup Artist & Hair Stylist | OMG`],
  makeup: (area) => [area && `Makeup in ${area} – Soft, Full & Bold Glam | OMG`, area && `Makeup in ${area} by ${ARTIST}`, area && `Makeup in ${area} – OMG`, `Makeup by ${ARTIST} – Soft, Full & Bold Glam | OMG`],
  hair: (area) => [area && `Hair Installation & Styling in ${area} | OMG`, area && `Hair Installation in ${area} – OMG`, area && `Hair in ${area} – OMG`, `Hair Installation & Styling by ${ARTIST} | OMG`],
  bridal: (area) => [area && `Bridal Makeup & Hair in ${area} | OMG – Oh! My Glam`, area && `Bridal Makeup & Hair in ${area} – OMG`, area && `Bridal Makeup in ${area} – OMG`, `Bridal Makeup & Hair by ${ARTIST} | OMG`],
};

export function pageTitle(site, page = 'home') {
  return TITLES[page](areaOf(site)).filter(Boolean).find((t) => chars(t) < 60);
}

/**
 * The first n prices and a closing line: the longest within 160 characters
 * wins, and a price is only dropped when all of them can't reach 150. (Google
 * shows about 155.)
 */
function fitDescription(lead, prices, tails) {
  let best = '';
  for (let n = prices.length; n >= 0 && chars(best) < 150; n -= 1) {
    const list = prices.slice(0, n).join(', ');
    const core = list ? `${lead} ${list[0].toUpperCase()}${list.slice(1)}.` : lead;
    for (const tail of tails) if (chars(core + tail) <= 160 && chars(core + tail) > chars(best)) best = core + tail;
  }
  return best || lead;
}

const TAILS = [' Home calls on request. Book your glam online or on WhatsApp.', ' Home calls on request. Book online or on WhatsApp.', ' Home calls on request. Book online.', ' Book online or on WhatsApp.', ' Book your glam online.', ' Book online today.', ' Book online.'];
const BRIDAL_TAILS = [' Home calls on request. Book your date online or on WhatsApp.', ' Book your wedding date online or on WhatsApp.', ' Book your date online or on WhatsApp.', ' Book your wedding date online.', ' Book your date online.', ' Book online.'];

/** Each page's description for Google, written from the Website tab's prices. */
export function metaDescription(site, page = 'home') {
  const services = visibleServices(site);
  const area = areaOf(site);
  const where = area ? ` in ${area}` : '';
  const from = (card) => fromPrice(services, card);
  const each = (card) => services.filter((s) => s.card === card).map((s) => `${s.name} R${s.price}`);
  const pkgs = services.filter((s) => s.card === 'package');
  const pkg = pkgs.length === 1 ? `${pkgs[0].name} R${pkgs[0].price}` : pkgs.length > 1 && `bridal packages from R${from('package')}`;
  switch (page) {
    case 'makeup':
      return fitDescription(`Makeup by ${ARTIST} (OMG – Oh! My Glam)${where}.`, each('makeup'), TAILS);
    case 'hair':
      return fitDescription(`Hair installation & styling by ${ARTIST} (OMG – Oh! My Glam)${where}.`, [...each('hair'), from('makeup') !== null && `makeup from R${from('makeup')}`].filter(Boolean), TAILS);
    case 'bridal':
      return fitDescription(`Bridal makeup & hair by ${ARTIST} (OMG – Oh! My Glam)${where}.`, [
        pkg,
        from('bride') !== null && `bride-only options from R${from('bride')}`,
        from('bridesmaid') !== null && `bridesmaids from R${from('bridesmaid')}`,
      ].filter(Boolean), BRIDAL_TAILS);
    default:
      return fitDescription(`${ARTIST}: makeup artist & hair stylist${where} (OMG – Oh! My Glam).`, [
        from('makeup') !== null && `makeup from R${from('makeup')}`,
        from('hair') !== null && `hair from R${from('hair')}`,
        pkg,
        from('bridesmaid') !== null && `bridesmaids from R${from('bridesmaid')}`,
      ].filter(Boolean), TAILS);
  }
}

/** The words under the logo in the H1 (HTML): who, what, and where once the area is set. */
const HERO = {
  home: `<b>${ARTIST}</b> · makeup artist &amp; hair stylist`,
  makeup: `Makeup by <b>${ARTIST}</b>`,
  hair: `Hair installation &amp; styling by <b>${ARTIST}</b>`,
  bridal: `Bridal makeup &amp; hair by <b>${ARTIST}</b>`,
};

export function heroLine(site, page = 'home') {
  const area = areaOf(site);
  return HERO[page] + (area ? ` in <b>${esc(area)}</b>` : '');
}

/** Who, what, where and how to book, in plain words (footer). */
export function aboutText(site) {
  const services = visibleServices(site);
  const area = areaOf(site);
  const from = (card) => fromPrice(services, card);
  const pkg = services.find((s) => s.card === 'package');
  const offers = [
    from('makeup') !== null && `makeup from R${from('makeup')}`,
    from('hair') !== null && `hair installation and styling from R${from('hair')}`,
    pkg && `the ${pkg.name} for R${pkg.price}`,
    from('bridesmaid') !== null && `bridesmaid makeup from R${from('bridesmaid')}`,
  ].filter(Boolean);
  const list = offers.length > 1 ? `${offers.slice(0, -1).join(', ')} and ${offers.at(-1)}` : offers.join('');
  return `OMG – Oh! My Glam is ${ARTIST}'s makeup and hair business${area ? ` in ${area}` : ''}: soft to bold glam, brides and bridesmaids. `
    + (list ? `Prices are in rand: ${list}. ` : '')
    + 'Home calls are available on request; transport is quoted separately. '
    + `To book, choose a service, a day and a free time in the booking calendar on this page, or WhatsApp or call ${formatPhone(site.text.phone || WHATSAPP_NUMBER)}.`;
}

/** The hero's "at a glance" chips, each linked to its prices. */
export function chipsHtml(site, page = 'home') {
  const services = visibleServices(site);
  const from = (card) => fromPrice(services, card);
  const pkg = services.find((s) => s.card === 'package');
  const each = (card) => services.filter((s) => s.card === card).slice(0, 3).map((s) => `<li><a href="#prices">${esc(s.name)} <b>R${s.price}</b></a></li>`);
  const chips = {
    home: () => [
      from('makeup') !== null && `<li><a href="/makeup">Makeup from <b>R${from('makeup')}</b></a></li>`,
      from('hair') !== null && `<li><a href="/hair">Hair from <b>R${from('hair')}</b></a></li>`,
      pkg && `<li><a href="/bridal">${esc(pkg.name)} <b>R${pkg.price}</b></a></li>`,
    ],
    makeup: () => each('makeup'),
    hair: () => each('hair'),
    bridal: () => [
      pkg && `<li><a href="#bridal">${esc(pkg.name)} <b>R${pkg.price}</b></a></li>`,
      from('bride') !== null && `<li><a href="#bridal">Bride from <b>R${from('bride')}</b></a></li>`,
      from('bridesmaid') !== null && `<li><a href="#bridal">Bridesmaids from <b>R${from('bridesmaid')}</b></a></li>`,
    ],
  }[page]();
  return [...chips, '<li>Home calls on request</li>'].filter(Boolean).join('');
}

/** The home page's menu: one card per service page, with what it offers and from what price. */
export function menuHtml(site) {
  const services = visibleServices(site);
  const card = (page, title, go, summary) => {
    const list = services.filter((s) => PAGES[page].cards.includes(s.card));
    if (!list.length) return '';
    return `<a class="card svc-card" href="${PAGES[page].path}"><div class="card-head"><h3 class="gold-text">${title}</h3><span>From R${Math.min(...list.map((s) => s.price))}</span></div>`
      + `<p class="svc-card-list">${summary(list).map(esc).join(' · ')}</p>`
      + `<span class="svc-card-go">${go} <svg class="icon" aria-hidden="true"><use href="#i-arrow"/></svg></span></a>`;
  };
  const names = (list) => list.map((s) => s.name);
  return [
    card('makeup', 'Makeup', 'See the makeup prices', names),
    card('hair', 'Hair', 'See the hair prices', names),
    card('bridal', 'Bridal', 'See the bridal prices', (list) => [
      ...list.filter((s) => s.card === 'package').map((s) => s.name),
      list.some((s) => s.card === 'bride') && 'Bride options',
      list.some((s) => s.card === 'bridesmaid') && 'Bridesmaids',
    ].filter(Boolean)),
  ].join('');
}

/** Who Asanda is, for the home page's "Meet Asanda Tiwani" (every fact is from the site). */
export function aboutBio(site) {
  const area = areaOf(site);
  return `${ARTIST} is the makeup artist and hair stylist behind OMG – Oh! My Glam${area ? `, based in ${area}` : ''}. `
    + `From soft everyday glam to bold looks and whole bridal parties, ${FIRST_NAME} does both the makeup and the hair, and comes to you on request.`;
}

// Reviews, as public/js/reviews.js draws them (card(), starRow(), renderSummary()).
function starRowHtml(value, label, key) {
  let stars = '';
  for (let i = 1; i <= 5; i += 1) {
    const fill = Math.max(0, Math.min(1, value - (i - 1)));
    const id = `rv-${key}-${i}`;
    stars += '<svg class="rv-star" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-star" class="rv-star-back"/>'
      + (fill > 0 ? `<clipPath id="${id}"><rect width="${24 * fill}" height="24"/></clipPath><use href="#i-star" class="rv-star-front" clip-path="url(#${id})"/>` : '')
      + '</svg>';
  }
  return `<span class="rv-starrow" role="img" aria-label="${esc(label)}">${stars}</span>`;
}

export function reviewCardHtml(r) {
  return `<li class="rv-card"><div class="rv-card-head"><strong>${esc(r.name)}</strong><span class="rv-date">${esc(formatMonth(String(r.date).slice(0, 7)))}</span></div>`
    + `${starRowHtml(r.rating, `${r.rating} out of 5 stars`, `r${r.id}`)}<p class="rv-comment">${esc(r.comment)}</p></li>`;
}

export function reviewSummaryHtml({ count, average }) {
  if (!count) return `<p class="rv-empty">No reviews yet. Had your glam done by ${FIRST_NAME}? Be the first to leave one.</p>`;
  const avg = average.toFixed(1);
  return `<span class="rv-score">${avg}</span>${starRowHtml(average, `Average ${avg} out of 5 stars`, 'avg')}`
    + `<span class="rv-outof">out of 5 · ${count} ${count === 1 ? 'review' : 'reviews'}</span>`;
}

/** The text under a shared link's title (WhatsApp, Facebook). */
export function shareDescription(site, page = 'home') {
  const services = visibleServices(site);
  const phone = formatPhone(site.text.phone || WHATSAPP_NUMBER);
  const from = (card) => fromPrice(services, card);
  const each = (card) => services.filter((s) => s.card === card).slice(0, 3).map((s) => `${s.name} R${s.price}`);
  const pkg = services.find((s) => s.card === 'package');
  const parts = {
    home: () => [...each('makeup'), from('hair') !== null && `Hair from R${from('hair')}`],
    makeup: () => each('makeup'),
    hair: () => each('hair'),
    bridal: () => [pkg && `${pkg.name} R${pkg.price}`, from('bride') !== null && `Bride from R${from('bride')}`, from('bridesmaid') !== null && `Bridesmaids from R${from('bridesmaid')}`],
  }[page]().filter(Boolean);
  return `${parts.length ? `${parts.join(' · ')}. ` : ''}Book online or on WhatsApp: ${phone}.`.slice(0, 300);
}

/** /llms.txt (llmstxt.org): the price list and how to book, as Markdown, from the same rows as the page. */
export function llmsTxt(site, origin) {
  const phone = site.text.phone || WHATSAPP_NUMBER;
  const one = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
  const item = (s) => {
    const included = s.card === 'package' ? detailGroups(s.details).flatMap((g) => g.items) : [];
    return `- ${one(s.name)}: R${s.price}${s.note ? ` (${one(s.note)})` : ''}${included.length ? `. Includes: ${included.map(one).join(', ')}.` : ''}`;
  };
  const services = visibleServices(site);
  const groups = SERVICE_GROUPS.map((group) => [group, services.filter((s) => GROUP_OF_CARD[s.card] === group)]).filter(([, list]) => list.length);
  const notes = [site.text.home_calls, site.text.bridal_note].filter(Boolean).map((t) => `- ${one(t)}`);
  const facebook = site.text.facebook_url && !/\/search\b/.test(site.text.facebook_url) ? site.text.facebook_url : '';
  const links = [
    `- [${ARTIST} and OMG – Oh! My Glam, photos, reviews and online booking](${origin}/)`,
    `- [Makeup prices](${origin}/makeup)`,
    `- [Hair prices](${origin}/hair)`,
    `- [Bridal makeup and hair prices](${origin}/bridal)`,
    `- [WhatsApp ${formatPhone(phone)}](https://wa.me/${phone})`,
    site.text.instagram && `- [Instagram @${one(site.text.instagram)}](${instagramUrl(site.text.instagram)})`,
    facebook && `- [Facebook](${facebook})`,
  ].filter(Boolean);
  return [
    '# OMG – Oh! My Glam', '',
    `> Makeup and hair styling by ${ARTIST}${areaOf(site) ? ` in ${one(areaOf(site))}` : ''}, including bridal and bridesmaid packages. Home calls available on request. Prices in South African rand (ZAR).`, '',
    `Book online at ${origin}/#book (pick a service, a day and a free time) or on WhatsApp: ${formatPhone(phone)}.`, '',
    ...groups.flatMap(([group, list]) => [`## ${group}`, '', ...list.map(item), '']),
    ...(notes.length ? ['## Good to know', '', ...notes, ''] : []),
    '## Links', '', ...links, '',
  ].join('\n');
}

/**
 * Turns public/index.html into one of the site's pages (PAGES): keeps that
 * page's sections, and sets its address, title and opening words. Needs no
 * database, so a page keeps its shape even if the content can't be read.
 */
export function pageShell(response, page) {
  const spec = PAGES[page];
  let rewriter = new HTMLRewriter()
    .on('[data-only]', {
      element(el) {
        if (el.getAttribute('data-only').split(/\s+/).includes(page)) el.removeAttribute('data-only');
        else el.remove();
      },
    })
    .on('link[rel="canonical"]', { element(el) { el.setAttribute('href', spec.canonical); } })
    .on('meta[property="og:url"]', { element(el) { el.setAttribute('content', spec.canonical); } })
    .on(`a[data-nav="${page}"]`, { element(el) { el.setAttribute('aria-current', 'page'); } });
  if (page !== 'home') {
    const bare = { text: {}, services: [] };
    const description = metaDescription(bare, page);
    const target = page === 'bridal' ? '#bridal' : '#prices';
    rewriter = rewriter
      .on('head > title', { element(el) { el.setInnerContent(pageTitle(bare, page)); } })
      .on('meta[property="og:title"]', { element(el) { el.setAttribute('content', pageTitle(bare, page)); } })
      .on('meta[name="description"]', { element(el) { el.setAttribute('content', description); } })
      .on('meta[property="og:description"]', { element(el) { el.setAttribute('content', description); } })
      .on('[data-cms-hero]', { element(el) { el.setInnerContent(heroLine(bare, page), { html: true }); } })
      .on('.hero .lede', { element(el) { el.removeAttribute('data-cms-text'); el.setInnerContent(spec.lede); } })
      .on('.hero-cta a[href="#services"]', { element(el) { el.setAttribute('href', target); el.setInnerContent(page === 'bridal' ? 'See the bridal prices' : 'See the prices'); } })
      .on('[data-cms-chips]', { element(el) { el.setInnerContent(''); } })
      .on('a.brand', { element(el) { el.setAttribute('href', '/'); el.setAttribute('aria-label', 'OMG – Oh! My Glam, home page'); } });
    if (spec.pricesTitle) {
      rewriter = rewriter
        .on('#prices-title', { element(el) { el.setInnerContent(spec.pricesTitle); } })
        .on('#prices .section-head p', { element(el) { el.setInnerContent(spec.pricesNote); } });
    }
  }
  return rewriter.transform(response);
}

/**
 * Writes the content into a page (after pageShell). The page in public/ holds
 * today's content too, so if the database can't be read the visitor still
 * gets a complete page; this only ever replaces it with the current version.
 */
export function renderPage(response, site, url, page = 'home') {
  const phone = site.text.phone || WHATSAPP_NUMBER;
  const byCard = (card) => visibleServices(site).filter((s) => s.card === card);
  const social = {
    // A Facebook search is not her page: shown only once a real page link is set.
    facebook: site.text.facebook_url && !/\/search\b/.test(site.text.facebook_url) ? site.text.facebook_url : '',
    instagram: instagramUrl(site.text.instagram),
  };
  const texts = {
    tagline: site.text.tagline,
    home_calls: site.text.home_calls,
    bridal_note: site.text.bridal_note,
    phone: formatPhone(phone),
    facebook_name: site.text.facebook_name || 'Facebook',
    instagram_handle: site.text.instagram ? `@${site.text.instagram}` : '',
  };
  const absolute = {
    element(meta) {
      const value = meta.getAttribute('content');
      if (value && value.startsWith('/') && !value.startsWith('//')) meta.setAttribute('content', url.origin + value);
    },
  };

  const out = new HTMLRewriter()
    .on('[data-cms-card]', {
      element(el) {
        if (!byCard(el.getAttribute('data-cms-card')).length) el.setAttribute('hidden', '');
      },
    })
    .on('[data-cms-list]', {
      element(el) {
        const card = el.getAttribute('data-cms-list');
        if (CARDS.includes(card)) el.setInnerContent(listHtml(card, site), { html: true });
      },
    })
    .on('[data-cms-photos]', {
      element(el) {
        const album = el.getAttribute('data-cms-photos');
        if (ALBUMS.includes(album)) el.setInnerContent(photosHtml(album, site), { html: true });
      },
    })
    .on('[data-cms-text]', {
      element(el) {
        const value = texts[el.getAttribute('data-cms-text')];
        if (typeof value === 'string' && value) el.setInnerContent(value);
      },
    })
    .on('[data-cms-social]', {
      element(el) {
        if (!social[el.getAttribute('data-cms-social')]) el.remove();
        else el.removeAttribute('hidden');
      },
    })
    .on('[data-cms-href]', {
      element(el) {
        const href = social[el.getAttribute('data-cms-href')];
        if (href) el.setAttribute('href', href);
      },
    })
    .on('a[href^="https://wa.me/"]', {
      element(el) {
        el.setAttribute('href', el.getAttribute('href').replace(/^https:\/\/wa\.me\/\d+/, `https://wa.me/${phone}`));
      },
    })
    .on('a[href^="tel:"]', { element(el) { el.setAttribute('href', `tel:+${phone}`); } })
    .on('a.phone', { element(el) { el.setAttribute('aria-label', `WhatsApp ${formatPhone(phone)}`); } })
    .on('head > title', { element(el) { el.setInnerContent(pageTitle(site, page)); } })
    .on('meta[property="og:title"]', { element(el) { el.setAttribute('content', pageTitle(site, page)); } })
    .on('[data-cms-hero]', { element(el) { el.setInnerContent(heroLine(site, page), { html: true }); } })
    .on('[data-cms-chips]', { element(el) { el.setInnerContent(chipsHtml(site, page), { html: true }); } })
    .on('[data-cms-menu]', { element(el) { el.setInnerContent(menuHtml(site), { html: true }); } })
    .on('[data-cms-bio]', { element(el) { el.setInnerContent(aboutBio(site)); } })
    .on('[data-cms-about]', { element(el) { el.setInnerContent(aboutText(site)); } })
    .on('#rv-summary', { element(el) { el.setInnerContent(reviewSummaryHtml(site.reviews), { html: true }); } })
    .on('#rv-list', {
      element(el) {
        el.setInnerContent(site.reviews.items.map(reviewCardHtml).join(''), { html: true });
        el.setAttribute('data-page', '1');
        el.setAttribute('data-more', String(site.reviews.hasMore));
      },
    })
    .on('meta[name="description"]', { element(el) { el.setAttribute('content', metaDescription(site, page)); } })
    .on('meta[property="og:description"]', { element(el) { el.setAttribute('content', shareDescription(site, page)); } })
    .on('meta[property="og:image"]', absolute)
    .on('meta[name="twitter:image"]', absolute)
    .on('script[type="application/ld+json"]', { element(el) { el.setInnerContent(jsonLd(site, url.origin), { html: true }); } })
    .on('script#omg-catalog', { element(el) { el.setInnerContent(catalogJson(site), { html: true }); } })
    .transform(response);

  // The page now changes when OMG edits it, so the file's own ETag no longer
  // describes it: browsers must ask again rather than reuse an old copy.
  const headers = new Headers(out.headers);
  headers.delete('etag');
  headers.delete('last-modified');
  headers.set('cache-control', 'no-cache');
  return new Response(out.body, { status: out.status, statusText: out.statusText, headers });
}

// ---------------------------------------------------------------- photos (media)

/** GET /media/<key>: a photo OMG uploaded, from KV. */
export async function media(request, env, key) {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' } });
  }
  const missing = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  if (!MEDIA_KEY.test(key) || !env.MEDIA) return missing();
  const etag = `"${key}"`;
  const cacheHeaders = { etag, 'cache-control': 'public, max-age=31536000, immutable' };
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: cacheHeaders });
  const body = await env.MEDIA.get(key, { type: 'stream' });
  if (!body) return missing();
  if (method === 'HEAD') await body.cancel();
  return new Response(method === 'HEAD' ? null : body, {
    headers: { ...cacheHeaders, 'content-type': key.endsWith('.webp') ? 'image/webp' : 'image/jpeg' },
  });
}

/** "webp" or "jpg" from a file's first bytes; anything else is refused. */
export function imageType(bytes) {
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  return null;
}

async function imageFile(file, field, maxBytes) {
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') throw invalid(field, 'Choose a photo to add.');
  if (file.size > maxBytes) throw new HttpError(413, 'too_large', 'That photo is too large. Please choose another.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = imageType(bytes);
  if (!ext) throw invalid(field, 'Only JPEG and WebP photos can be added.');
  return { bytes, ext };
}

const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------- admin routes

/** GET /api/admin/site: everything on the Website tab, hidden services included. */
export async function getSite(ctx) {
  await guard(ctx);
  forgetSite(ctx.env);
  const site = await loadSite(ctx.env);
  const text = Object.fromEntries(TEXT_KEYS.map((k) => [k, site.text[k] ?? '']));
  return json({ ok: true, services: site.services, text, photos: site.photos });
}

/** A permanent id for a new service, from its name: "lash-lift-k3f9". */
export function newServiceId(name) {
  const base = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') || 'service';
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const suffix = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => alphabet[b % alphabet.length]).join('');
  return `${base}-${suffix}`;
}

const serviceOut = (s) => ({ ...s });

/** POST /api/admin/site/services: a new service at the end of its card. */
export async function createService(ctx) {
  await guard(ctx);
  await enforce(ctx.env, 'siteEdit', ctx.client);
  const input = serviceInput(await readJson(ctx.request));
  const db = ctx.env.DB;
  const count = await db.prepare('SELECT COUNT(*) AS n FROM services').first();
  if (count.n >= MAX_SERVICES) throw invalid('card', `The site already lists ${MAX_SERVICES} services. Delete one first.`);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const id = newServiceId(input.name);
    try {
      const row = await db.prepare(
        'INSERT INTO services (id, card, name, price, minutes, note, level, details, sort, visible, updated_at) '
        + 'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, (SELECT COALESCE(MAX(sort), 0) + 1 FROM services WHERE card = ?2), ?9, ?10) RETURNING *',
      ).bind(id, input.card, input.name, input.price, input.minutes, input.note, input.level, input.details, input.visible, Date.now()).first();
      forgetSite(ctx.env);
      return json({ ok: true, service: serviceOut(row) }, 201);
    } catch (error) {
      if (!String(error && error.message).includes('UNIQUE')) throw error;
    }
  }
  throw new Error('could not allocate a service id');
}

/** POST /api/admin/site/services/:id: every field replaced; a new card puts it last there. */
export async function updateService(ctx) {
  await guard(ctx);
  await enforce(ctx.env, 'siteEdit', ctx.client);
  const id = ctx.params[0];
  const input = serviceInput(await readJson(ctx.request));
  const db = ctx.env.DB;
  const current = await db.prepare('SELECT card FROM services WHERE id = ?1').bind(id).first();
  if (!current) throw notFound('That service no longer exists.');
  const row = await db.prepare(
    'UPDATE services SET card = ?2, name = ?3, price = ?4, minutes = ?5, note = ?6, level = ?7, details = ?8, visible = ?9, updated_at = ?10, '
    + 'sort = CASE WHEN card = ?2 THEN sort ELSE (SELECT COALESCE(MAX(sort), 0) + 1 FROM services WHERE card = ?2) END '
    + 'WHERE id = ?1 RETURNING *',
  ).bind(id, input.card, input.name, input.price, input.minutes, input.note, input.level, input.details, input.visible, Date.now()).first();
  forgetSite(ctx.env);
  return json({ ok: true, service: serviceOut(row) });
}

/** DELETE /api/admin/site/services/:id. Requests already made keep their details. */
export async function deleteService(ctx) {
  await guard(ctx);
  await enforce(ctx.env, 'siteEdit', ctx.client);
  const result = await ctx.env.DB.prepare('DELETE FROM services WHERE id = ?1').bind(ctx.params[0]).run();
  if (!result.meta.changes) throw notFound('That service no longer exists.');
  forgetSite(ctx.env);
  return json({ ok: true });
}

function idList(value, field, pattern) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_SERVICES + MAX_PHOTOS) throw invalid(field, 'That order could not be saved.');
  for (const id of value) if (!pattern(id)) throw invalid(field, 'That order could not be saved.');
  if (new Set(value).size !== value.length) throw invalid(field, 'That order could not be saved.');
  return value;
}

/** POST /api/admin/site/services-order { card, ids }: the card's services, in order. */
export async function orderServices(ctx) {
  await guard(ctx);
  await enforce(ctx.env, 'siteEdit', ctx.client);
  const body = await readJson(ctx.request);
  if (!CARDS.includes(body.card)) throw invalid('card', 'That order could not be saved.');
  const ids = idList(body.ids, 'ids', (id) => typeof id === 'string' && SERVICE_ID.test(id));
  const db = ctx.env.DB;
  const { results } = await db.prepare('SELECT id FROM services WHERE card = ?1').bind(body.card).all();
  const existing = new Set(results.map((r) => r.id));
  if (existing.size !== ids.length || ids.some((id) => !existing.has(id))) throw invalid('ids', 'The list changed. Reload the page and try again.');
  await db.batch(ids.map((id, i) => db.prepare('UPDATE services SET sort = ?1 WHERE id = ?2 AND card = ?3').bind(i + 1, id, body.card)));
  forgetSite(ctx.env);
  return json({ ok: true });
}

/** POST /api/admin/site/text: any of the contact details and texts. */
export async function updateText(ctx) {
  await guard(ctx);
  await enforce(ctx.env, 'siteEdit', ctx.client);
  const body = await readJson(ctx.request);
  const values = {};
  if ('phone' in body) values.phone = phoneDigits(body.phone);
  if ('instagram' in body) values.instagram = instagramHandle(body.instagram);
  if ('facebook_url' in body) values.facebook_url = facebookUrl(body.facebook_url);
  if ('facebook_name' in body) {
    values.facebook_name = textField(body.facebook_name, 'facebook_name', { min: 0, max: 60, message: 'Keep the Facebook name to 60 characters.' });
  }
  if ('area' in body) values.area = textField(body.area, 'area', { min: 0, max: 28, message: 'Write the area in up to 28 characters, e.g. Soweto, Johannesburg.' });
  if ('tagline' in body) values.tagline = textField(body.tagline, 'tagline', { min: 10, max: 220, message: 'Write the welcome line in 10 to 220 characters.' });
  if ('home_calls' in body) values.home_calls = textField(body.home_calls, 'home_calls', { min: 5, max: 300, message: 'Write the home-calls note in 5 to 300 characters.' });
  if ('bridal_note' in body) values.bridal_note = textField(body.bridal_note, 'bridal_note', { min: 5, max: 300, message: 'Write the bridal note in 5 to 300 characters.' });
  const keys = Object.keys(values);
  if (!keys.length) throw invalid('text', 'Nothing to save.');
  const db = ctx.env.DB;
  await db.batch(keys.map((k) => db.prepare('INSERT INTO site_text (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(k, values[k])));
  forgetSite(ctx.env);
  return json({ ok: true, text: values });
}

/**
 * POST /api/admin/site/photos (multipart): a photo the admin page has already
 * resized, as a large and a small copy, with its album and description.
 */
export async function uploadPhoto(ctx) {
  await guard(ctx);
  await enforce(ctx.env, 'upload', ctx.client, 'That is a lot of photos for one hour. Please wait a while before adding more.');
  const { request, env } = ctx;
  const declared = request.headers.get('content-length');
  if (!declared || !/^\d+$/.test(declared)) throw new HttpError(411, 'length_required', 'The photo could not be read. Please try again.');
  if (Number(declared) > MAX_UPLOAD_BYTES) throw new HttpError(413, 'too_large', 'That photo is too large. Please choose another.');
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('multipart/form-data')) {
    throw new HttpError(415, 'unsupported_media_type', 'Send the photo as a form upload.');
  }
  if (!env.MEDIA) throw new HttpError(503, 'not_configured', 'Photo storage has not been set up yet.');
  let form;
  try {
    form = await request.formData();
  } catch {
    throw unreadable();
  }
  const album = form.get('album');
  if (!ALBUMS.includes(album)) throw invalid('album', 'Choose where the photo goes.');
  const alt = photoAlt(form.get('alt'));
  const size = (name, min, max) => {
    const n = Number(form.get(name));
    if (!Number.isInteger(n) || n < min || n > max) throw invalid(name, 'The photo could not be read. Please try again.');
    return n;
  };
  const width = size('width', 100, 4000);
  const height = size('height', 100, 4000);
  const smallWidth = size('small_width', 50, width);
  const large = await imageFile(form.get('large'), 'large', MAX_LARGE_BYTES);
  const small = await imageFile(form.get('small'), 'small', MAX_SMALL_BYTES);
  const db = env.DB;
  const count = await db.prepare('SELECT COUNT(*) AS n FROM photos WHERE album = ?1').bind(album).first();
  if (count.n >= MAX_PHOTOS) throw invalid('album', `This album already has ${MAX_PHOTOS} photos. Delete one first.`);
  const id = randomHex(16);
  const largeKey = `${id}-l.${large.ext}`;
  const smallKey = `${id}-s.${small.ext}`;
  await Promise.all([env.MEDIA.put(largeKey, large.bytes), env.MEDIA.put(smallKey, small.bytes)]);
  const row = await db.prepare(
    'INSERT INTO photos (album, src, src_small, width, height, small_width, alt, sort, created_at) '
    + 'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, (SELECT COALESCE(MAX(sort), 0) + 1 FROM photos WHERE album = ?1), ?8) RETURNING *',
  ).bind(album, `/media/${largeKey}`, `/media/${smallKey}`, width, height, smallWidth, alt, Date.now()).first();
  forgetSite(env);
  return json({ ok: true, photo: row }, 201);
}

/** POST /api/admin/site/photos/:id { alt }: a new description. */
export async function updatePhoto(ctx) {
  await guard(ctx);
  await enforce(ctx.env, 'siteEdit', ctx.client);
  const body = await readJson(ctx.request);
  const alt = photoAlt(body.alt);
  const row = await ctx.env.DB.prepare('UPDATE photos SET alt = ?1 WHERE id = ?2 RETURNING *').bind(alt, Number(ctx.params[0])).first();
  if (!row) throw notFound('That photo no longer exists.');
  forgetSite(ctx.env);
  return json({ ok: true, photo: row });
}

/** DELETE /api/admin/site/photos/:id, and its files if it was uploaded. */
export async function deletePhoto(ctx) {
  await guard(ctx);
  await enforce(ctx.env, 'siteEdit', ctx.client);
  const row = await ctx.env.DB.prepare('DELETE FROM photos WHERE id = ?1 RETURNING src, src_small').bind(Number(ctx.params[0])).first();
  if (!row) throw notFound('That photo no longer exists.');
  forgetSite(ctx.env);
  const keys = [row.src, row.src_small].filter((s) => s.startsWith('/media/')).map((s) => s.slice('/media/'.length)).filter((k) => MEDIA_KEY.test(k));
  if (keys.length && ctx.env.MEDIA) {
    const removal = Promise.all(keys.map((k) => ctx.env.MEDIA.delete(k))).catch((e) => console.warn('media_delete_failed', String(e && e.message)));
    if (ctx.waitUntil) ctx.waitUntil(removal);
    else await removal;
  }
  return json({ ok: true });
}

/** POST /api/admin/site/photos-order { album, ids }: the album, in order. */
export async function orderPhotos(ctx) {
  await guard(ctx);
  await enforce(ctx.env, 'siteEdit', ctx.client);
  const body = await readJson(ctx.request);
  if (!ALBUMS.includes(body.album)) throw invalid('album', 'That order could not be saved.');
  const ids = idList(body.ids, 'ids', (id) => Number.isInteger(id) && id > 0 && id < 1e9);
  const db = ctx.env.DB;
  const { results } = await db.prepare('SELECT id FROM photos WHERE album = ?1').bind(body.album).all();
  const existing = new Set(results.map((r) => r.id));
  if (existing.size !== ids.length || ids.some((id) => !existing.has(id))) throw invalid('ids', 'The album changed. Reload the page and try again.');
  await db.batch(ids.map((id, i) => db.prepare('UPDATE photos SET sort = ?1 WHERE id = ?2 AND album = ?3').bind(i + 1, id, body.album)));
  forgetSite(ctx.env);
  return json({ ok: true });
}
