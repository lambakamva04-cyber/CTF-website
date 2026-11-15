// The editable website content (src/content.js): escaping, the checks on what
// is typed on the Website tab, the HTML and JSON written into the page, and
// the seeded content. Runs against a real SQLite database built from
// migrations/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.match(C.metaDescription(site), /^OMG – Oh! My Glam price list: Soft Glam R750, Full Glam R850, Bold \/ Dramatic R950, Basic Installation R400, Curling Long Weave R450\. Bridal Package R4500, bridesmaids from R850\./);
  const ld = JSON.parse(C.jsonLd(site, 'https://omg.example'));
  assert.equal(ld.telephone, '+27785767604');
  assert.equal(ld.priceRange, 'R400 – R4500');
  assert.equal(ld.hasOfferCatalog.itemListElement.length, 12);
  assert.deepEqual(ld.sameAs, ['https://www.instagram.com/asanda_tiwani/'], 'a Facebook search link is not a profile');
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
