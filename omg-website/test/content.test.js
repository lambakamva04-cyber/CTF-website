// The editable website content (src/content.js): escaping, the checks on what
// is typed on the Website tab, the HTML and JSON written into the page, and
// the seeded content. Runs against a real SQLite database built from
// migrations/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../src/content.js';
import { HOURS } from '../public/js/catalog.js';
import { toMinutes } from '../public/js/slots.js';
import { freshDb } from './d1.js';

const rejects = (fn, field) => assert.throws(fn, (e) => e.status === 400 && e.extra.field === field, `expected a 400 on ${field}`);
const service = (over = {}) => ({ card: 'makeup', name: 'Soft Glam', price: 750, minutes: 90, note: null, level: 1, details: null, visible: true, ...over });

test('esc() and safeJson() leave nothing a browser would run', () => {
  assert.equal(C.esc(`<img src=x onerror="a('1')">&`), '&lt;img src=x onerror=&quot;a(&#39;1&#39;)&quot;&gt;&amp;');
  const json = C.safeJson({ name: '</script><script>alert(1)</script>', amp: 'a & b', line: 'x\u2028y' });
  assert.ok(!/[<>&\u2028]/.test(json), json);
  assert.deepEqual(JSON.parse(json), { name: '</script><script>alert(1)</script>', amp: 'a & b', line: 'x\u2028y' });
});

test('phone numbers: local, international, and nonsense', () => {
  assert.equal(C.phoneDigits('078 576 7604'), '27785767604');
  assert.equal(C.phoneDigits('+27 (78) 576-7604'), '27785767604');
  assert.equal(C.phoneDigits('0027785767604'), '27785767604');
  assert.equal(C.phoneDigits('+44 20 7946 0958'), '442079460958');
  for (const bad of ['', '12345', '078 576 7604 ext 2', '+0785767604', "078' OR 1=1", null, 785767604]) rejects(() => C.phoneDigits(bad), 'phone');
  assert.equal(C.formatPhone('27785767604'), '+27 78 576 7604');
  assert.equal(C.formatPhone('442079460958'), '+442079460958');
});

test('Instagram and Facebook links: only the real sites, or empty to hide', () => {
  for (const ok of ['asanda_tiwani', '@asanda_tiwani', 'https://www.instagram.com/asanda_tiwani/', 'instagram.com/asanda_tiwani?igsh=x']) {
    assert.equal(C.instagramHandle(ok), 'asanda_tiwani', ok);
  }
  assert.equal(C.instagramHandle(''), '');
  for (const bad of ['asanda tiwani', 'https://evil.example/asanda', 'a'.repeat(31), '<script>']) rejects(() => C.instagramHandle(bad), 'instagram');
  assert.equal(C.facebookUrl('https://www.facebook.com/omgglam'), 'https://www.facebook.com/omgglam');
  assert.equal(C.facebookUrl('facebook.com/omgglam'), 'https://facebook.com/omgglam');
  assert.equal(C.facebookUrl('http://m.facebook.com/omgglam'), 'https://m.facebook.com/omgglam', 'upgraded to https');
  assert.equal(C.facebookUrl(''), '');
  assert.equal(C.facebookUrl('https://www.facebook.com/profile.php?id=100012345678901'), 'https://www.facebook.com/profile.php?id=100012345678901', 'a personal profile link keeps its id');
  for (const bad of ['javascript:alert(1)', 'https://facebook.com.evil.example/x', 'https://evil.example/facebook.com', 'https://user:pw@facebook.com/x', 'https://facebook.com:8443/x', 'data:text/html,hi']) {
    rejects(() => C.facebookUrl(bad), 'facebook_url');
  }
});

test('a service is checked field by field', () => {
  assert.deepEqual(C.serviceInput(service()), { card: 'makeup', name: 'Soft Glam', price: 750, minutes: 90, note: null, level: 1, details: null, visible: 1 });
  assert.equal(C.serviceInput(service({ card: 'hair', level: 2 })).level, null, 'glam level only on makeup');
  assert.equal(C.serviceInput(service({ details: 'Hair:\nCurls' })).details, null, 'details only on the package');
  assert.equal(C.serviceInput(service({ card: 'package', details: 'Hair:\nCurls' })).details, 'Hair:\nCurls');
  assert.equal(C.serviceInput(service({ note: '   ' })).note, null);
  assert.equal(C.serviceInput(service({ name: '  Soft   Glam ​ ' })).name, 'Soft Glam', 'tidied');
  rejects(() => C.serviceInput(service({ card: 'nails' })), 'card');
  for (const name of ['', 'x', 'y'.repeat(61), 42]) rejects(() => C.serviceInput(service({ name })), 'name');
  for (const price of [-1, 100001, 7.5, '750', null]) rejects(() => C.serviceInput(service({ price })), 'price');
  for (const minutes of [10, 735, 50, 90.5, '90']) rejects(() => C.serviceInput(service({ minutes })), 'minutes');
  rejects(() => C.serviceInput(service({ note: 'n'.repeat(61) })), 'note');
  rejects(() => C.serviceInput(service({ level: 4 })), 'level');
  rejects(() => C.serviceInput(service({ card: 'package', details: 'x\n'.repeat(31) })), 'details');
  rejects(() => C.serviceInput(service({ visible: 'yes' })), 'visible');
});

test('the package text: items, and lines ending in ":" as headings', () => {
  assert.deepEqual(C.detailGroups('Hair:\nWeave\n\n  Style  \nMakeup:\nLashes\nEmpty:'), [
    { heading: 'Hair', items: ['Weave', 'Style'] },
    { heading: 'Makeup', items: ['Lashes'] },
  ]);
  assert.deepEqual(C.detailGroups('Just this'), [{ heading: '', items: ['Just this'] }]);
  assert.deepEqual(C.detailGroups(null), []);
});

test('what is typed reaches the page as text, never as markup', () => {
  const evil = { id: 'x-1', card: 'bride', name: '<script>alert(1)</script>"', price: 900, minutes: 60, note: '<b>n</b>', level: null };
  const item = C.serviceItem(evil, '27785767604');
  assert.ok(!item.includes('<script>') && !item.includes('<b>'), item);
  assert.ok(item.includes('&lt;script&gt;alert(1)&lt;/script&gt;&quot;'));
  const pkg = C.packageArticle({ ...evil, card: 'package', details: 'H<i>:\n<img src=x>' }, '27785767604');
  assert.ok(!/<img|<i>|<script>/.test(pkg), pkg);
  const photo = C.photoItem({ album: 'looks', src: 'javascript:alert(1)', src_small: '/media/../x', width: 720, height: 900, small_width: 360, alt: '"><script>' });
  assert.ok(!photo.includes('javascript:') && !photo.includes('/media/../') && !photo.includes('<script>'), photo);
  assert.match(photo, /src="\/img\/logo\.webp"/, 'unknown paths fall back to the logo');
});

test('the seeded content is what the site showed, and fits the booking rules', async () => {
  const { env } = freshDb();
  const site = await C.loadSite(env);
  assert.equal(site.services.length, 12);
  assert.equal(site.photos.filter((p) => p.album === 'looks').length, 5);
  assert.equal(site.photos.filter((p) => p.album === 'before_after').length, 5);
  assert.equal(site.text.phone, '27785767604');
  const open = toMinutes(HOURS.close) - toMinutes(HOURS.open);
  for (const s of site.services) {
    assert.doesNotThrow(() => C.serviceInput({ ...s, visible: Boolean(s.visible) }), s.id);
    assert.ok(s.minutes <= open, `${s.id} fits in a day`);
  }
  const catalog = JSON.parse(C.catalogJson(site));
  assert.deepEqual(catalog.services.map((s) => s.group), ['Makeup', 'Makeup', 'Makeup', 'Hair', 'Hair', 'Bridal', 'Bridal', 'Bridal', 'Bridal', 'Bridal', 'Bridesmaid', 'Bridesmaid']);
  assert.deepEqual(catalog.services.find((s) => s.id === 'full-glam'), { id: 'full-glam', group: 'Makeup', name: 'Full Glam', price: 850, minutes: 90 });
  assert.equal(C.metaDescription(site), 'Asanda Tiwani: bridal hair & makeup artist (OMG – Oh! My Glam). Bridal Package R4500, bridesmaids from R850, makeup from R750, hair from R400. Book online.');
  assert.equal(C.pageTitle(site), 'Asanda Tiwani – Bridal Hair & Makeup Artist | OMG');
  for (const area of ['Soweto', 'Johannesburg', 'Pietermaritzburg', 'Soweto & Johannesburg South']) {
    const withArea = { ...site, text: { ...site.text, area } };
    const title = C.pageTitle(withArea); const description = C.metaDescription(withArea);
    assert.ok(title.includes(area) && [...title].length < 60, title);
    assert.ok(description.includes(` in ${area}`) && [...description].length >= 150 && [...description].length <= 160, description);
  }
  assert.equal(site.reviews.count, 0);
  const node = (json, type) => JSON.parse(json)['@graph'].find((n) => n['@type'] === type);
  const website = node(C.jsonLd(site, 'https://omg.example'), 'WebSite');
  const ld = node(C.jsonLd(site, 'https://omg.example'), 'HealthAndBeautyBusiness');
  assert.equal(website['@type'], 'WebSite');
  assert.deepEqual(website.publisher, { '@id': ld['@id'] });
  assert.equal(ld.telephone, '+27785767604');
  assert.equal(ld.priceRange, 'R400 – R4500');
  assert.equal(ld.hasOfferCatalog.itemListElement.length, 12);
  assert.deepEqual(ld.sameAs, ['https://www.instagram.com/asanda_tiwani/'], 'a Facebook search link is not a profile');
  // No area set: a country-only address, no areaServed, no "in …".
  assert.deepEqual(ld.address, { '@type': 'PostalAddress', addressCountry: 'ZA' });
  assert.equal(ld.areaServed, undefined);
  assert.ok(ld.image.every((u) => u.startsWith('https://omg.example/')), 'every image is absolute');
  const withArea = node(C.jsonLd({ ...site, text: { ...site.text, area: 'Soweto, Johannesburg' } }, 'https://omg.example'), 'HealthAndBeautyBusiness');
  assert.deepEqual(withArea.address, { '@type': 'PostalAddress', addressLocality: 'Soweto, Johannesburg', addressCountry: 'ZA' });
  assert.equal(withArea.areaServed, 'Soweto, Johannesburg');
  assert.match(withArea.description, /^Bridal hair and makeup for brides and bridesmaids by Asanda Tiwani in Soweto, Johannesburg, plus /);
  // The area is escaped wherever it lands.
  const sneaky = { ...site, text: { ...site.text, area: '<b>x</b></script>' } };
  assert.ok(!C.jsonLd(sneaky, 'https://omg.example').includes('</script>'));
  assert.ok(!C.heroLine(sneaky).includes('<b>x</b>'));
  // /llms.txt: the same facts as the page, with the area once it is set.
  const llms = C.llmsTxt(site, 'https://omg.example');
  assert.match(llms, /^# OMG – Oh! My Glam\n\n> Bridal hair and makeup for brides and bridesmaids by Asanda Tiwani, plus soft to bold glam/);
  assert.match(llms, /- Soft Glam: R750/);
  assert.match(C.llmsTxt({ ...site, text: { ...site.text, area: 'Soweto' } }, 'https://omg.example'), /> Bridal hair and makeup for brides and bridesmaids by Asanda Tiwani in Soweto, plus/);
});

test('hidden services are neither shown nor bookable', async () => {
  const { db, env } = freshDb();
  db.prepare("UPDATE services SET visible = 0 WHERE id = 'bold-dramatic'").run();
  const site = await C.loadSite(env);
  assert.ok(!C.listHtml('makeup', site).includes('Bold / Dramatic'));
  assert.ok(!JSON.parse(C.catalogJson(site)).services.some((s) => s.id === 'bold-dramatic'));
  assert.equal(await C.bookableService(env, 'bold-dramatic'), null);
  assert.equal((await C.bookableService(env, 'full-glam')).minutes, 90);
  assert.equal(await C.bookableService(env, "full-glam' OR 1=1 --"), null);
});

test('new service ids come from the name, with a random ending', () => {
  assert.match(C.newServiceId('Lash Lift!'), /^lash-lift-[a-z2-9]{4}$/);
  assert.match(C.newServiceId('Crème brûlée glam'), /^creme-brulee-glam-[a-z2-9]{4}$/);
  assert.match(C.newServiceId('мейкап'), /^service-[a-z2-9]{4}$/);
  assert.ok(C.newServiceId('x'.repeat(80)).length <= 35);
  assert.notEqual(C.newServiceId('Glam'), C.newServiceId('Glam'));
});

test('only JPEG and WebP files are taken as photos', () => {
  const bytes = (...b) => Uint8Array.from([...b, ...new Array(16).fill(0)]);
  assert.equal(C.imageType(bytes(0xff, 0xd8, 0xff, 0xe0)), 'jpg');
  assert.equal(C.imageType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50)), 'webp');
  assert.equal(C.imageType(bytes(0x89, 0x50, 0x4e, 0x47)), null, 'PNG');
  assert.equal(C.imageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null, 'SVG');
  assert.equal(C.imageType(bytes(0x47, 0x49, 0x46, 0x38)), null, 'GIF');
  assert.equal(C.imageType(new Uint8Array(2)), null);
});

test('the area OMG works in can be saved (migration 0006), and every other text is kept', async () => {
  const { db, env } = freshDb();
  const before = db.prepare('SELECT key, value FROM site_text ORDER BY key').all();
  db.prepare("INSERT INTO site_text (key, value) VALUES ('area', 'Soweto, Johannesburg')").run();
  assert.throws(() => db.prepare("INSERT INTO site_text (key, value) VALUES ('nonsense', 'x')").run(), /CHECK/);
  const site = await C.loadSite(env);
  assert.equal(site.text.area, 'Soweto, Johannesburg');
  for (const row of before) assert.equal(site.text[row.key], row.value, row.key);
  assert.equal(C.pageTitle(site), 'Asanda Tiwani – Bridal Hair & Makeup, Soweto, Johannesburg');
  assert.equal(C.heroLine(site), '<b>Asanda Tiwani</b> · bridal hair &amp; makeup artist in <b>Soweto, Johannesburg</b>');
});

test('a Facebook link, once saved, shows everywhere Instagram does', async () => {
  const { db, env } = freshDb();
  const link = 'https://www.facebook.com/profile.php?id=100012345678901';
  db.prepare("INSERT INTO site_text (key, value) VALUES ('facebook_url', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(link);
  const site = await C.loadSite(env);
  const graph = JSON.parse(C.jsonLd(site, 'https://omg.example'))['@graph'];
  const instagram = 'https://www.instagram.com/asanda_tiwani/';
  for (const type of ['Person', 'HealthAndBeautyBusiness']) {
    assert.deepEqual(graph.find((n) => n['@type'] === type).sameAs, [instagram, link], `${type}: Google links both profiles to the site`);
  }
  assert.ok(C.llmsTxt(site, 'https://omg.example').includes(`- [Facebook](${link})`));
});

test('every image in the page has alt text (Bing flags an empty one)', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const images = html.match(/<img\b[^>]*>/g);
  assert.ok(images.length >= 13, `${images.length} images`);
  for (const img of images) assert.match(img, /\salt="[^"]+"/, img.slice(0, 90));
  // The top-bar logo names its link through its alt text, not an aria-label on the link.
  assert.match(html, /<a class="brand" href="#top">\s*<img [^>]*alt="OMG – Oh! My Glam, back to top">/);
});

test('a photo needs a real description, not its file name', () => {
  for (const bad of ['IMG_2041.jpg', 'IMG_2041', 'dsc 0042', 'photo.HEIC', 'PXL_20261101', 'x']) rejects(() => C.photoAlt(bad), 'alt');
  assert.equal(C.photoAlt('Soft glam with a nude lip'), 'Soft glam with a nude lip');
  assert.equal(C.photoAlt('Bridal look, image 2 of 3'), 'Bridal look, image 2 of 3');
});

test('every page has its own title, description, H1 and chips, from the same content', async () => {
  const site = await C.loadSite(freshDb().env);
  // The simple view (/, the whole site on one page) and the full menu (every option a page).
  assert.deepEqual(Object.keys(C.PAGES), ['home', 'menu', 'makeup', 'hair', 'bridal', 'gallery', 'reviews', 'book']);
  assert.deepEqual(Object.values(C.PAGES).map((p) => p.path), ['/', '/menu', '/makeup', '/hair', '/bridal', '/gallery', '/reviews', '/book']);
  assert.ok(Object.values(C.PAGES).every((p) => p.canonical === `https://ohmyglam.online${p.path}`));
  // Google gets the one-page site and the service pages; the rest repeat it.
  assert.deepEqual(Object.keys(C.PAGES).filter((page) => C.PAGES[page].index), ['home', 'makeup', 'hair', 'bridal']);
  assert.deepEqual(Object.keys(C.PAGES).filter((page) => C.PAGES[page].calendar), ['home', 'book']);
  assert.deepEqual(Object.keys(C.PAGES).map((page) => C.pageTitle(site, page)), [
    'Asanda Tiwani – Bridal Hair & Makeup Artist | OMG',
    'Asanda Tiwani – Makeup, Hair & Bridal | OMG – Oh! My Glam',
    'Makeup by Asanda Tiwani – Soft, Full & Bold Glam | OMG',
    'Hair Installation & Styling by Asanda Tiwani | OMG',
    'Bridal Hair & Makeup Packages – Asanda Tiwani | OMG',
    'Photos – Makeup & Hair by Asanda Tiwani | OMG',
    'Client Reviews – Asanda Tiwani | OMG – Oh! My Glam',
    'Book an Appointment with Asanda Tiwani | OMG',
  ]);
  assert.deepEqual(Object.keys(C.PAGES).map((page) => C.heroLine(site, page)), [
    '<b>Asanda Tiwani</b> · bridal hair &amp; makeup artist',
    '<b>Asanda Tiwani</b> · bridal hair &amp; makeup artist',
    'Makeup by <b>Asanda Tiwani</b>',
    'Hair installation &amp; styling by <b>Asanda Tiwani</b>',
    'Bridal hair &amp; makeup by <b>Asanda Tiwani</b>',
    'Makeup &amp; hair photos by <b>Asanda Tiwani</b>',
    'Client reviews for <b>Asanda Tiwani</b>',
    'Book your glam with <b>Asanda Tiwani</b>',
  ]);
  for (const area of ['', 'Soweto', 'Johannesburg', 'Soweto, Johannesburg', 'Soweto & Johannesburg South', 'x'.repeat(28)]) {
    const s2 = { ...site, text: { ...site.text, area } };
    for (const page of Object.keys(C.PAGES)) {
      const title = C.pageTitle(s2, page);
      const description = C.metaDescription(s2, page);
      assert.ok([...title].length < 60, `${page} title ${title}`);
      assert.ok([...description].length >= 150 && [...description].length <= 160, `${page} ${[...description].length}: ${description}`);
      assert.ok(description.includes('Asanda Tiwani'), 'the artist is named');
      if (area) assert.ok(description.includes(` in ${area}`) && C.heroLine(s2, page).endsWith(` in <b>${C.esc(area)}</b>`), `${page}: ${description}`);
      if (area && C.PAGES[page].index) assert.ok(title.includes(area), `${page}: ${title}`);
    }
  }
  assert.match(C.metaDescription(site, 'makeup'), /^Makeup by Asanda Tiwani \(OMG – Oh! My Glam\)\. Soft Glam R750, Full Glam R850, Bold \/ Dramatic R950\./);
  assert.match(C.metaDescription(site, 'hair'), /^Hair installation & styling by Asanda Tiwani \(OMG – Oh! My Glam\)\. Basic Installation R400, Curling Long Weave R450/);
  assert.match(C.metaDescription(site, 'bridal'), /^Bridal hair & makeup packages by Asanda Tiwani \(OMG – Oh! My Glam\)\. Bridal Package R4500, bride-only options from R750, bridesmaids from R850\./);
  // Chips: the simple view points down its page, the full menu at its pages.
  const hrefs = (html) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs(C.chipsHtml(site)), ['#prices', '#prices', '#bridal']);
  assert.deepEqual(hrefs(C.chipsHtml(site, 'menu')), ['/makeup', '/hair', '/bridal']);
  for (const page of ['gallery', 'reviews', 'book']) assert.equal(C.chipsHtml(site, page), '', `${page} has a short header`);
  assert.deepEqual(hrefs(C.chipsHtml(site, 'makeup')), ['#prices', '#prices', '#prices']);
  assert.deepEqual(hrefs(C.chipsHtml(site, 'hair')), ['#prices', '#prices']);
  assert.deepEqual(hrefs(C.chipsHtml(site, 'bridal')), ['#bridal', '#bridal', '#bridal']);
  // The full menu: a card for every option, each to its own page.
  const menu = C.menuHtml(site);
  assert.deepEqual(hrefs(menu), ['/makeup', '/hair', '/bridal', '/gallery', '/reviews', '/book']);
  assert.ok(menu.includes('<h3 class="gold-text">Gallery</h3><span>10 photos</span>'), menu);
  assert.ok(menu.includes('From R750</span></div><p class="svc-card-list">Soft Glam · Full Glam · Bold / Dramatic</p>'), menu);
  assert.ok(menu.includes('<p class="svc-card-list">Bridal Package · Bride options · Bridesmaids</p>'), menu);
  assert.match(C.shareDescription(site, 'bridal'), /^Bridal Package R4500 · Bride from R750 · Bridesmaids from R850\. Book online or on WhatsApp: \+27 78 576 7604\.$/);
  assert.match(C.shareDescription(site, 'hair'), /^Basic Installation R400 · Curling Long Weave R450\. /);
  // Asanda Tiwani: a Person of her own, linked to the business, for name searches.
  const graph = JSON.parse(C.jsonLd({ ...site, text: { ...site.text, area: 'Soweto' } }, 'https://omg.example'))['@graph'];
  const person = graph.find((n) => n['@type'] === 'Person');
  const biz = graph.find((n) => n['@type'] === 'HealthAndBeautyBusiness');
  assert.equal(person.name, 'Asanda Tiwani');
  assert.deepEqual(person.worksFor, { '@id': biz['@id'] });
  assert.deepEqual(biz.founder, { '@id': person['@id'] });
  assert.deepEqual(person.sameAs, ['https://www.instagram.com/asanda_tiwani/']);
  assert.equal(person.jobTitle, 'Bridal hair and makeup artist');
  assert.deepEqual(person.workLocation, { '@type': 'Place', name: 'Soweto' });
  assert.equal(C.aboutBio(site), 'Asanda Tiwani is the bridal hair and makeup artist behind OMG – Oh! My Glam. From soft everyday glam to bold looks and whole bridal parties, Asanda does both the makeup and the hair, and comes to you on request.');
  assert.match(C.aboutBio({ ...site, text: { ...site.text, area: 'Soweto' } }), /behind OMG – Oh! My Glam, based in Soweto\. /);
  assert.match(C.aboutText(site), /^OMG – Oh! My Glam is Asanda Tiwani's bridal hair and makeup business: /);
  const llms = C.llmsTxt(site, 'https://omg.example');
  for (const path of ['/makeup', '/hair', '/bridal']) assert.ok(llms.includes(`](https://omg.example${path})`), path);
  assert.match(C.reviewSummaryHtml({ count: 0 }), /Had your glam done by Asanda\?/);
});
