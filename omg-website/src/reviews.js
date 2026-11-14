// Public reviews: the approved list, and new reviews (held for approval).

import { UTC_OFFSET_MINUTES } from '../public/js/catalog.js';
import { nowInZone } from '../public/js/slots.js';
import { invalid, json, readJson } from './http.js';
import { enforce } from './ratelimit.js';
import { looksAutomated, rating, reviewComment, reviewName } from './validate.js';

const PAGE_SIZE = 6;

/** GET /api/reviews?page=N: approved reviews, newest first. */
export async function list({ env, url, client }) {
  await enforce(env, 'read', client);
  const pageParam = url.searchParams.get('page') ?? '1';
  if (!/^[1-9]\d{0,3}$/.test(pageParam)) throw invalid('page', 'That page does not exist.');
  const page = Number(pageParam);

  const stats = await env.DB.prepare("SELECT COUNT(*) AS count, AVG(rating) AS average FROM reviews WHERE status = 'approved'").first();
  const { results } = await env.DB.prepare(
    "SELECT id, name, rating, comment, approved_at, created_at FROM reviews WHERE status = 'approved' " +
      'ORDER BY created_at DESC, id DESC LIMIT ?1 OFFSET ?2',
  )
    .bind(PAGE_SIZE + 1, (page - 1) * PAGE_SIZE)
    .all();

  const count = stats ? stats.count : 0;
  // Not cached: OMG approves a review and expects to see it straight away.
  return json(
    {
      ok: true,
      average: count ? Math.round(stats.average * 100) / 100 : null,
      count,
      page,
      hasMore: results.length > PAGE_SIZE,
      reviews: results.slice(0, PAGE_SIZE).map((row) => ({
        id: row.id,
        name: row.name,
        rating: row.rating,
        comment: row.comment,
        date: nowInZone(UTC_OFFSET_MINUTES, row.created_at).date,
      })),
    },
  );
}

/** POST /api/reviews: stored pending until OMG approves it. */
export async function create({ env, request, client }) {
  await enforce(env, 'reviewTry', client);
  const body = await readJson(request);
  const review = {
    name: reviewName(body.name),
    rating: rating(body.rating),
    comment: reviewComment(body.comment),
  };
  if (looksAutomated(body)) return json({ ok: true }, 201);

  await enforce(env, 'review', client, 'Thank you! You have left a few reviews today already. Please try again tomorrow.');
  await enforce(env, 'reviewAll', 'all', 'We are receiving a lot of reviews right now. Please try again tomorrow.');
  await env.DB.prepare("INSERT INTO reviews (name, rating, comment, status, created_at) VALUES (?1, ?2, ?3, 'pending', ?4)")
    .bind(review.name, review.rating, review.comment, Date.now())
    .run();
  return json({ ok: true }, 201);
}
