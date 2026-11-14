// OMG – Oh! My Glam: static site, booking and reviews API, admin API.
//
// Every request comes here first (run_worker_first), so every response,
// whether a page, an image or JSON, leaves with the security headers.

import { UTC_OFFSET_MINUTES } from '../public/js/catalog.js';
import { addDays, nowInZone } from '../public/js/slots.js';
import * as admin from './admin.js';
import * as bookings from './bookings.js';
import { HttpError, checkOrigin, errorResponse, notFound } from './http.js';
import { clientId } from './ratelimit.js';
import * as reviews from './reviews.js';
import { withSecurityHeaders } from './security.js';

const ID = '(\\d{1,9})';
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
].map(([method, path, handler]) => ({ method, pattern: new RegExp(`^${path}$`), handler }));

async function api(request, env, url) {
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
    return await route.handler({ request, env, url, params, client });
  } catch (error) {
    return errorResponse(error);
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    const response = isApi ? await api(request, env, url) : await env.ASSETS.fetch(request);
    return withSecurityHeaders(response, url);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(purge(env));
  },
};
