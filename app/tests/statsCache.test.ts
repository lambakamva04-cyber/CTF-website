import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker/env';
import {
  bumpStatsVersion,
  cachedStats,
  readStatsVersion,
  STATS_CACHE_TTL_SECONDS,
  statsCacheKey,
} from '../worker/lib/statsCache';

/** The two calls the helper makes on a Cache, kept in a Map like a real cache would. */
function memoryCache() {
  const store = new Map<string, Response>();
  return {
    store,
    match: vi.fn(async (key: RequestInfo | URL) => store.get(String(key))?.clone()),
    put: vi.fn(async (key: RequestInfo | URL, response: Response) => {
      store.set(String(key), response);
    }),
  };
}

/** Just enough of D1 for one statement: what was run, and what it returns or throws. */
function fakeDb(behaviour: { first?: unknown; throws?: Error }) {
  const statements: { sql: string; args: unknown[] }[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          statements.push({ sql, args });
          return {
            async first() {
              if (behaviour.throws) throw behaviour.throws;
              return behaviour.first ?? null;
            },
            async run() {
              if (behaviour.throws) throw behaviour.throws;
              return { success: true };
            },
          };
        },
      };
    },
  };
  return { env: { DB } as unknown as Env, statements };
}

const KEY = statsCacheKey('https://app.cutthroughfaster.com', ['metrics', 'org_a', 'today', 1]);

describe('cachedStats', () => {
  it('works the answer out once, then serves it from the cache', async () => {
    const cache = memoryCache();
    const compute = vi.fn(async () => ({ total: 4, booked: 3 }));

    const first = await cachedStats(KEY, compute, { cache });
    const second = await cachedStats(KEY, compute, { cache });

    expect(first).toEqual({ value: { total: 4, booked: 3 }, hit: false });
    expect(second).toEqual({ value: { total: 4, booked: 3 }, hit: true });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('keeps an answer for one minute', async () => {
    const cache = memoryCache();
    await cachedStats(KEY, async () => ({ total: 1 }), { cache });
    const stored = cache.store.get(KEY);
    expect(stored?.headers.get('cache-control')).toBe(`max-age=${STATS_CACHE_TTL_SECONDS}`);
    expect(STATS_CACHE_TTL_SECONDS).toBe(60);
  });

  it('treats a different key as a different answer', async () => {
    const cache = memoryCache();
    const otherKey = statsCacheKey('https://app.cutthroughfaster.com', ['metrics', 'org_a', 'today', 2]);
    await cachedStats(KEY, async () => ({ total: 1 }), { cache });
    const after = await cachedStats(otherKey, async () => ({ total: 2 }), { cache });
    expect(after).toEqual({ value: { total: 2 }, hit: false });
  });

  it('caches nothing when there is no key', async () => {
    const cache = memoryCache();
    const compute = vi.fn(async () => ({ total: 1 }));
    await cachedStats(null, compute, { cache });
    await cachedStats(null, compute, { cache });
    expect(compute).toHaveBeenCalledTimes(2);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('works without a cache at all, as on workers.dev or in tests', async () => {
    const result = await cachedStats(KEY, async () => ({ total: 7 }), { cache: null });
    expect(result).toEqual({ value: { total: 7 }, hit: false });
  });

  it('answers anyway when reading the cache fails', async () => {
    const cache = memoryCache();
    cache.match.mockRejectedValueOnce(new Error('cache down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await cachedStats(KEY, async () => ({ total: 3 }), { cache });
    expect(result).toEqual({ value: { total: 3 }, hit: false });
    warn.mockRestore();
  });

  it('answers anyway when writing the cache fails', async () => {
    const cache = memoryCache();
    cache.put.mockRejectedValueOnce(new Error('cache full'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await cachedStats(KEY, async () => ({ total: 3 }), { cache });
    expect(result).toEqual({ value: { total: 3 }, hit: false });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('hands the cache write to waitUntil instead of making the answer wait', async () => {
    const cache = memoryCache();
    const waited: Promise<unknown>[] = [];
    await cachedStats(KEY, async () => ({ total: 1 }), {
      cache,
      waitUntil: (promise) => waited.push(promise),
    });
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(cache.store.has(KEY)).toBe(true);
  });

  it('never caches a failed calculation', async () => {
    const cache = memoryCache();
    await expect(
      cachedStats(KEY, async () => {
        throw new Error('database down');
      }, { cache }),
    ).rejects.toThrow('database down');
    expect(cache.put).not.toHaveBeenCalled();
  });
});

describe('statsCacheKey', () => {
  it('keeps every part separate, including a time zone with a slash', () => {
    const key = statsCacheKey('https://app.cutthroughfaster.com', [
      'metrics',
      'org_a',
      'week',
      'Africa/Johannesburg',
      1790892000000,
      3,
    ]);
    expect(key).toBe(
      'https://app.cutthroughfaster.com/api/__stats-cache/v1/metrics/org_a/week/Africa%2FJohannesburg/1790892000000/3',
    );
  });

  it('sits under /api/, which outside requests only ever reach through the Worker', () => {
    expect(new URL(KEY).pathname.startsWith('/api/')).toBe(true);
  });

  it('gives two organizations two keys', () => {
    const a = statsCacheKey('https://x.test', ['metrics', 'org_a', 'today', 1]);
    const b = statsCacheKey('https://x.test', ['metrics', 'org_b', 'today', 1]);
    expect(a).not.toBe(b);
  });

  it('cannot be confused by a part that contains the separator', () => {
    const a = statsCacheKey('https://x.test', ['metrics', 'org/a', 'today']);
    const b = statsCacheKey('https://x.test', ['metrics', 'org', 'a/today']);
    expect(a).not.toBe(b);
  });
});

describe('stats_version', () => {
  it('reads the organization’s version', async () => {
    const { env, statements } = fakeDb({ first: { stats_version: 5 } });
    expect(await readStatsVersion(env, 'org_a')).toBe(5);
    expect(statements[0]?.args).toEqual(['org_a']);
  });

  it('turns caching off, without an error, before migration 0007', async () => {
    const { env } = fakeDb({ throws: new Error('no such column: stats_version') });
    expect(await readStatsVersion(env, 'org_a')).toBeNull();
  });

  it('turns caching off for an organization that is not there', async () => {
    const { env } = fakeDb({ first: null });
    expect(await readStatsVersion(env, 'org_missing')).toBeNull();
  });

  it('bumps only the one organization', async () => {
    const { env, statements } = fakeDb({});
    await bumpStatsVersion(env, 'org_a');
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain('stats_version = stats_version + 1');
    expect(statements[0]?.args).toEqual(['org_a']);
  });

  it('never stops a call from being recorded, even before migration 0007', async () => {
    const { env } = fakeDb({ throws: new Error('no such column: stats_version') });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(bumpStatsVersion(env, 'org_a')).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
