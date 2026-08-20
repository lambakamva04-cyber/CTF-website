import { describe, expect, it } from 'vitest';
import { CURRENT_VERSIONS } from '../shared/legal';
import {
  canonicalFor,
  canonicalOrigin,
  INDEXABLE_PATHS,
  robotsTagFor,
  sitemapXml,
} from '../worker/lib/seo';

describe('crawl policy', () => {
  it('keeps every private route out of the index', () => {
    // The dashboard, the sign-in page and the signup form. A login page in a
    // search result is a liability, not traffic.
    for (const path of ['/', '/signup', '/dashboard', '/anything-else']) {
      expect(robotsTagFor(path)).toBe('noindex, nofollow');
    }
  });

  it('allows the three legal documents', () => {
    for (const path of ['/terms', '/privacy', '/operator']) {
      expect(robotsTagFor(path)).toBeNull();
    }
  });

  it('treats a trailing slash as the same page', () => {
    // A crawler will try both spellings. Answering differently for each would
    // deindex half of them for no reason.
    expect(robotsTagFor('/terms/')).toBeNull();
    expect(robotsTagFor('/privacy/')).toBeNull();
    expect(robotsTagFor('/')).toBe('noindex, nofollow');
  });

  it('is case-sensitive, matching how the router resolves paths', () => {
    // App.tsx matches '/terms' exactly, so '/Terms' renders the dashboard
    // route. Marking it indexable would expose the sign-in shell.
    expect(robotsTagFor('/Terms')).toBe('noindex, nofollow');
  });
});

describe('sitemap', () => {
  const xml = sitemapXml('https://app.cutthroughfaster.com');

  it('lists exactly the pages the crawl policy allows', () => {
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? '');
    expect(locs).toEqual([
      'https://app.cutthroughfaster.com/terms',
      'https://app.cutthroughfaster.com/privacy',
      'https://app.cutthroughfaster.com/operator',
    ]);

    // A sitemap that advertises a noindexed URL is a contradiction Search
    // Console reports as an error, so the two lists must not drift apart.
    for (const loc of locs) {
      expect(robotsTagFor(new URL(loc).pathname)).toBeNull();
    }
    expect(locs).toHaveLength(INDEXABLE_PATHS.size);
  });

  it('dates each entry from the document version it describes', () => {
    for (const version of Object.values(CURRENT_VERSIONS)) {
      expect(xml).toContain(`<lastmod>${version}</lastmod>`);
    }
  });

  it('emits lastmod in the W3C date format sitemaps require', () => {
    for (const match of xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) {
      const value = match[1] ?? '';
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(value))).toBe(false);
    }
  });

  it('is well-formed enough to parse', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    // Balanced tags, checked the cheap way: every opener has a closer.
    for (const tag of ['urlset', 'url', 'loc', 'lastmod']) {
      const open = [...xml.matchAll(new RegExp(`<${tag}[ >]`, 'g'))].length;
      const close = [...xml.matchAll(new RegExp(`</${tag}>`, 'g'))].length;
      expect(open).toBe(close);
    }
  });

  it('builds absolute URLs from the origin it is given', () => {
    expect(sitemapXml('https://ctf-app.workers.dev')).toContain(
      '<loc>https://ctf-app.workers.dev/terms</loc>',
    );
  });
});

describe('canonical address', () => {
  const requestUrl = new URL('https://ctf-app.workers.dev/terms');

  it('prefers the configured origin over the host that was asked', () => {
    // Both hostnames serve identical pages. Whichever one a crawler happens to
    // reach, the answer has to name the same address, or the two compete.
    expect(canonicalOrigin({ CANONICAL_ORIGIN: 'https://app.cutthroughfaster.com' }, requestUrl))
      .toBe('https://app.cutthroughfaster.com');
  });

  it('tolerates a trailing slash in the configured value', () => {
    expect(canonicalOrigin({ CANONICAL_ORIGIN: 'https://app.cutthroughfaster.com/' }, requestUrl))
      .toBe('https://app.cutthroughfaster.com');
  });

  it('never falls back to http', () => {
    // http and https are two different sites to a crawler. A sitemap served
    // over http would otherwise advertise URLs nobody is indexing.
    expect(canonicalOrigin({}, new URL('http://app.cutthroughfaster.com/terms'))).toBe(
      'https://app.cutthroughfaster.com',
    );
  });

  it('ignores an empty or whitespace-only setting', () => {
    expect(canonicalOrigin({ CANONICAL_ORIGIN: '   ' }, requestUrl)).toBe(
      'https://ctf-app.workers.dev',
    );
  });

  it('names a canonical URL only for pages that may be indexed', () => {
    const origin = 'https://app.cutthroughfaster.com';
    expect(canonicalFor(origin, '/terms')).toBe('https://app.cutthroughfaster.com/terms');
    expect(canonicalFor(origin, '/terms/')).toBe('https://app.cutthroughfaster.com/terms');
    expect(canonicalFor(origin, '/')).toBeNull();
    expect(canonicalFor(origin, '/signup')).toBeNull();
  });
});
