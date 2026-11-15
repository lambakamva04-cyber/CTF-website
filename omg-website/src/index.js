// OMG – Oh! My Glam: static site, booking and reviews API, admin API.
//
// Every request comes here first (run_worker_first), so every response,
// whether a page, an image or JSON, leaves with the security headers.

import { UTC_OFFSET_MINUTES } from '../public/js/catalog.js';
import { addDays, nowInZone } from '../public/js/slots.js';
import * as admin from './admin.js';
import * as bookings from './bookings.js';
import * as calendar from './calendar.js';
import * as content from './content.js';
import { HttpError, checkOrigin, errorResponse, notFound } from './http.js';
import * as push from './push.js';
import { clientId } from './ratelimit.js';
import * as reviews from './reviews.js';
import { withSecurityHeaders } from './security.js';

const ID = '(\\d{1,9})';
const SERVICE = '([a-z0-9][a-z0-9-]{0,38}[a-z0-9])';
const FEED = /^\/calendar\/([^/]{1,100})\.ics$/;
const ROUTES = [
  ['GET', '/api/availability', bookings.availability],
  ['POST', '/api/bookings', bookings.create],
  ['GET', '/api/reviews', reviews.list],
  ['POST', '/api/reviews', reviews.create],
  ['POST', '/api/admin/login', admin.login],
  ['POST', '/api/admin/logout', admin.logout],
  ['GET', '/api/admin/session', admin.session],
  ['GET', '/api/admin/requests', admin.listRequests],
  ['POST', `/api/admin/requests/${ID}/confirm`, admin.confirmRequest],
  ['POST', `/api/admin/requests/${ID}/decline`, admin.declineRequest],
  ['GET', '/api/admin/blocks', admin.listBlocks],
  ['POST', '/api/admin/blocks', admin.createBlock],
  ['DELETE', `/api/admin/blocks/${ID}`, admin.deleteBlock],
  ['GET', '/api/admin/reviews', admin.listReviews],
  ['POST', `/api/admin/reviews/${ID}/approve`, admin.approveReview],
  ['DELETE', `/api/admin/reviews/${ID}`, admin.deleteReview],
  ['GET', '/api/admin/push/key', push.key],
  ['POST', '/api/admin/push/subscribe', push.subscribe],
  ['POST', '/api/admin/push/unsubscribe', push.unsubscribe],
  ['POST', '/api/admin/push/test', push.test],
  ['GET', '/api/admin/push/latest', push.latest],
  ['GET', '/api/admin/site', content.getSite],
  ['POST', '/api/admin/site/services', content.createService],
  ['POST', `/api/admin/site/services/${SERVICE}`, content.updateService],
  ['DELETE', `/api/admin/site/services/${SERVICE}`, content.deleteService],
  ['POST', '/api/admin/site/services-order', content.orderServices],
  ['POST', '/api/admin/site/text', content.updateText],
  ['POST', '/api/admin/site/photos', content.uploadPhoto],
  ['POST', `/api/admin/site/photos/${ID}`, content.updatePhoto],
  ['DELETE', `/api/admin/site/photos/${ID}`, content.deletePhoto],
  ['POST', '/api/admin/site/photos-order', content.orderPhotos],
  ['GET', '/api/admin/calendar-sync', calendar.getSync],
  ['POST', '/api/admin/calendar-sync/feed-reset', calendar.resetFeed],
  ['POST', '/api/admin/calendar-sync/import', calendar.connectImport],
  ['DELETE', '/api/admin/calendar-sync/import', calendar.disconnectImport],
  ['POST', '/api/admin/calendar-sync/sync', calendar.syncNow],
].map(([method, path, handler]) => ({ method, pattern: new RegExp(`^${path}$`), handler }));

async function api(request, env, url, ctx) {
  try {
    const candidates = ROUTES.filter((r) => r.pattern.test(url.pathname));
    if (!candidates.length) throw notFound();
    const method = request.method.toUpperCase();
    const route = candidates.find((r) => r.method === method);
    if (!route) {
      throw new HttpError(405, 'method_not_allowed', 'That is not allowed here.', {
        allow: [...new Set(candidates.map((r) => r.method))].join(', '),
      });
    }
    if (method !== 'GET') checkOrigin(request, url);
    const params = url.pathname.match(route.pattern).slice(1);
    const client = await clientId(env, request);
    const waitUntil = ctx ? (promise) => ctx.waitUntil(promise) : undefined;
    return await route.handler({ request, env, url, params, client, waitUntil });
  } catch (error) {
    return errorResponse(error);
  }
}

/** The private feed of bookings that OMG's calendar app subscribes to (src/calendar.js). */
async function calendarFeed(request, env, token) {
  try {
    return await calendar.feed(request, env, token, await clientId(env, request));
  } catch (error) {
    console.error('calendar_feed_failed', String(error && error.message));
    return new Response('Try again later', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '300' } });
  }
}

/**
 * Daily clean-up, so personal data does not outlive its purpose: requests
 * nobody confirmed, client details 30 days after the appointment, old
 * calendar entries, expired sessions and spent rate-limit counters.
 */
export async function purge(env, nowMs = Date.now()) {
  const today = nowInZone(UTC_OFFSET_MINUTES, nowMs).date;
  const monthAgo = addDays(today, -30);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?1').bind(nowMs),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(nowMs),
    env.DB.prepare("DELETE FROM booking_requests WHERE status = 'pending' AND (date < ?1 OR created_at < ?2)").bind(today, nowMs - 30 * 86_400_000),
    env.DB.prepare('UPDATE blocks SET label = NULL, request_id = NULL WHERE date < ?1').bind(monthAgo),
    env.DB.prepare("DELETE FROM booking_requests WHERE status = 'confirmed' AND date < ?1").bind(monthAgo),
    env.DB.prepare('DELETE FROM blocks WHERE date < ?1').bind(addDays(today, -180)),
  ]);
}

/**
 * WhatsApp, Facebook and Instagram only show a link's preview image when its
 * URL is absolute. The page says "/og.jpg"; make that absolute for whichever
 * domain served it (workers.dev now, OMG's own domain later), so nobody has to
 * edit the page when the domain changes.
 */
function absoluteShareImage(response, url) {
  if (response.status !== 200 || !response.body) return response;
  if (!(response.headers.get('content-type') || '').startsWith('text/html')) return response;
  const absolute = {
    element(meta) {
      const value = meta.getAttribute('content');
      if (value && value.startsWith('/') && !value.startsWith('//')) meta.setAttribute('content', url.origin + value);
    },
  };
  return new HTMLRewriter()
    .on('meta[property="og:image"]', absolute)
    .on('meta[name="twitter:image"]', absolute)
    .transform(response);
}

/**
 * The home page, with the current services, prices, photos and contact
 * details written in (src/content.js). If they can't be read, the file's own
 * content is served, which is complete but may be older.
 */
async function homePage(request, env, url) {
  // The page is rewritten as it is served, so a stored copy's validators say
  // nothing about it: always fetch the file whole.
  const headers = new Headers(request.headers);
  headers.delete('if-none-match');
  headers.delete('if-modified-since');
  const asset = await env.ASSETS.fetch(new Request(request, { headers }));
  if (asset.status !== 200 || !asset.body || !(asset.headers.get('content-type') || '').startsWith('text/html')) {
    return absoluteShareImage(asset, url);
  }
  try {
    return content.renderPage(asset, await content.loadSite(env), url);
  } catch (error) {
    console.error('site_content_unavailable', String(error && error.message));
    return absoluteShareImage(asset, url);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let response;
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) response = await api(request, env, url, ctx);
    else if (url.pathname.startsWith('/media/')) response = await content.media(request, env, url.pathname.slice('/media/'.length));
    else if (url.pathname === '/') response = await homePage(request, env, url);
    else if (FEED.test(url.pathname)) response = await calendarFeed(request, env, url.pathname.match(FEED)[1]);
    else response = absoluteShareImage(await env.ASSETS.fetch(request), url);
    return withSecurityHeaders(response, url);
  },

  // Every 15 minutes: read OMG's own calendar for busy times. Once a day, in
  // the 01:00 UTC run (03:00 in South Africa), also the clean-up. One schedule
  // for both: the free plan allows five per account.
  async scheduled(controller, env, ctx) {
    const at = new Date(controller.scheduledTime);
    const jobs = [calendar.syncCalendar(env)];
    if (at.getUTCHours() === 1 && at.getUTCMinutes() < 15) jobs.push(purge(env));
    ctx.waitUntil(Promise.allSettled(jobs).then((results) => {
      for (const r of results) if (r.status === 'rejected') console.error('scheduled_job_failed', String(r.reason && r.reason.message));
    }));
  },
};
