import type { Env } from '../env';

/**
 * A one-minute cache for the dashboard's call statistics.
 *
 * Every signed-in dashboard asks for its statistics once a minute, and each
 * answer costs up to ten database queries. Most of those answers are the same
 * as the last one, so the first in a minute is kept in Cloudflare's cache and
 * the rest are served from it.
 *
 * It must never show a number that is out of date because something changed.
 * So the key carries the organization's stats_version, which goes up whenever a
 * call is added or ends (bumpStatsVersion), and everything else the answer
 * depends on: the period, the local day, the time zone and the plan's terms. A
 * change to any of them is a different key; the old entry is simply never asked
 * for again and expires on its own.
 *
 * What is cached stays inside the Worker. The browser still gets
 * `cache-control: no-store`, and the key sits under /api/, which every outside
 * request reaches only through the Worker's own routing, never the cache.
 *
 * The cache is per Cloudflare data centre and best-effort. A miss, an error, a
 * workers.dev host (where the Cache API stores nothing), or a database that has
 * not had migration 0007 yet all fall back to working the numbers out directly,
 * exactly as before the cache existed.
 */

/** Long enough to absorb the once-a-minute polling, short enough to be harmless. */
export const STATS_CACHE_TTL_SECONDS = 60;

type CacheLike = Pick<Cache, 'match' | 'put'>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The organization's current stats_version, or null when it cannot be read —
 * before migration 0007 the column does not exist — in which case nothing is
 * cached.
 */
export async function readStatsVersion(env: Env, orgId: string): Promise<number | null> {
  try {
    const row = await env.DB.prepare('SELECT stats_version FROM organizations WHERE id = ?')
      .bind(orgId)
      .first<{ stats_version: number | null }>();
    return typeof row?.stats_version === 'number' ? row.stats_version : null;
  } catch {
    return null;
  }
}

/**
 * Marks the organization's statistics as changed. Called after the change is
 * written, so a request that sees the new version also sees the new data.
 *
 * Never throws: a call being recorded matters more than a cache being cleared,
 * and before migration 0007 there is nothing cached to clear.
 */
export async function bumpStatsVersion(env: Env, orgId: string): Promise<void> {
  try {
    await env.DB.prepare('UPDATE organizations SET stats_version = stats_version + 1 WHERE id = ?')
      .bind(orgId)
      .run();
  } catch (error) {
    console.warn(`stats cache: version not bumped for ${orgId}: ${message(error)}`);
  }
}

/** The cache key for one answer. Every part is encoded, so "Africa/Johannesburg" stays one part. */
export function statsCacheKey(origin: string, parts: (string | number)[]): string {
  const path = parts.map((part) => encodeURIComponent(String(part))).join('/');
  return `${origin}/api/__stats-cache/v1/${path}`;
}

function defaultCache(): CacheLike | null {
  try {
    return typeof caches === 'undefined' ? null : caches.default;
  } catch {
    return null;
  }
}

/**
 * Returns the cached answer for `key`, or works it out with `compute` and keeps
 * it for a minute. A null key means "do not cache". Any cache failure is logged
 * and treated as a miss: the cache can only ever make an answer faster, never
 * stop one.
 */
export async function cachedStats<T>(
  key: string | null,
  compute: () => Promise<T>,
  options: {
    cache?: CacheLike | null;
    waitUntil?: (promise: Promise<unknown>) => void;
  } = {},
): Promise<{ value: T; hit: boolean }> {
  const cache = options.cache === undefined ? defaultCache() : options.cache;
  if (!key || !cache) return { value: await compute(), hit: false };

  try {
    const cached = await cache.match(key);
    if (cached) return { value: (await cached.json()) as T, hit: true };
  } catch (error) {
    console.warn(`stats cache: read failed: ${message(error)}`);
  }

  const value = await compute();

  const stored = cache
    .put(
      key,
      new Response(JSON.stringify(value), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `max-age=${STATS_CACHE_TTL_SECONDS}`,
        },
      }),
    )
    .catch((error: unknown) => console.warn(`stats cache: write failed: ${message(error)}`));

  // Stored after the answer is sent where the runtime allows it, so a slow
  // cache write never slows the dashboard down.
  if (options.waitUntil) options.waitUntil(stored);
  else await stored;

  return { value, hit: false };
}
