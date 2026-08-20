/**
 * What a search engine may index on the platform.
 *
 * The platform is a private dashboard sitting behind authentication, so the
 * default is that nothing here belongs in Google. The exception is the three
 * legal documents: they are genuinely public, prospects and their lawyers do go
 * looking for them, and they are the single source of truth for the text a
 * client accepted — the marketing site links here rather than keeping a second
 * copy that can drift out of step with the version consent was recorded
 * against.
 */
import { CURRENT_VERSIONS, type LegalDocumentId } from '../../shared/legal';

export const INDEXABLE_PATHS = new Set(['/terms', '/privacy', '/operator']);

/** Header value for a path, or null when the path may be indexed. */
export function robotsTagFor(pathname: string): string | null {
  // A trailing slash is the same page to a browser and a different URL to a
  // crawler, so both spellings resolve the same way here.
  const normalised =
    pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;

  return INDEXABLE_PATHS.has(normalised) ? null : 'noindex, nofollow';
}

const DOCUMENTS: LegalDocumentId[] = ['terms', 'privacy', 'operator'];

/**
 * The one address these pages are published at.
 *
 * The platform answers on at least two hostnames — the custom domain and the
 * workers.dev fallback — and both serve identical content. Left alone that is
 * duplicate content, and Google picks a winner itself, which may be the
 * workers.dev URL. Pinning the canonical settles it.
 *
 * Falls back to the request's own origin so a preview deployment still produces
 * a coherent sitemap rather than one pointing at production.
 */
export function canonicalOrigin(env: { CANONICAL_ORIGIN?: string }, requestUrl: URL): string {
  const configured = env.CANONICAL_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  // Never http: a crawler treats http and https as two different sites, so an
  // http sitemap would advertise a set of URLs that are not the ones being
  // indexed.
  return `https://${requestUrl.host}`;
}

/** The canonical URL for a path, or null where the path is not published. */
export function canonicalFor(origin: string, pathname: string): string | null {
  return robotsTagFor(pathname) === null ? `${origin}${pathname.replace(/\/$/, '')}` : null;
}

/**
 * The sitemap, built from the documents themselves rather than kept as a static
 * file. Each document's version is the date it last changed, so `lastmod` is
 * accurate by construction — a hand-maintained sitemap goes stale the first
 * time someone edits a policy and forgets, and a wrong `lastmod` teaches Google
 * to stop trusting the file.
 */
export function sitemapXml(origin: string): string {
  const entries = DOCUMENTS.map(
    (id) =>
      `  <url>\n` +
      `    <loc>${origin}/${id}</loc>\n` +
      `    <lastmod>${CURRENT_VERSIONS[id]}</lastmod>\n` +
      `    <changefreq>yearly</changefreq>\n` +
      `    <priority>0.3</priority>\n` +
      `  </url>`,
  ).join('\n');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${entries}\n` +
    `</urlset>\n`
  );
}
