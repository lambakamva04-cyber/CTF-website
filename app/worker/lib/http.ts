import type { ApiErrorBody } from '../../shared/types';
import type { Env } from '../env';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
export const unauthorized = (message = 'Please sign in again.') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to that.') =>
  new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);
export const tooManyRequests = (message: string, retryAfter: number) =>
  new HttpError(429, 'rate_limited', message, retryAfter);
export const upstreamError = (message: string) => new HttpError(502, 'upstream_error', message);

const API_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(API_HEADERS)) headers.set(k, v);
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function noContent(init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('cache-control', 'no-store');
  return new Response(null, { ...init, status: 204, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    const body: ApiErrorBody = { error: error.code, message: error.message };
    const headers: Record<string, string> = {};
    if (error.retryAfter !== undefined) {
      body.retryAfter = error.retryAfter;
      headers['retry-after'] = String(error.retryAfter);
    }
    return json(body, { status: error.status, headers });
  }

  // Never surface internal exception text to a client browser.
  console.error('unhandled_error', error);
  const body: ApiErrorBody = {
    error: 'internal_error',
    message: 'Something went wrong on our side. Please try again.',
  };
  return json(body, { status: 500 });
}

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * CSRF defence for cookie-authenticated mutations. The session cookie is
 * SameSite=Lax, which already blocks cross-site POSTs from forms; this rejects
 * the remaining cases (and any misconfigured proxy) by requiring the Origin
 * header to name a host we serve.
 */
export function assertTrustedOrigin(request: Request, env: Env): void {
  if (request.method === 'GET' || request.method === 'HEAD') return;

  const origin = request.headers.get('origin');
  if (!origin) {
    // Same-origin fetch() from a browser always sends Origin on mutations.
    throw forbidden('Missing origin header.');
  }

  const allowed = allowedOrigins(env);
  const requestOrigin = new URL(request.url).origin;
  if (origin === requestOrigin || allowed.includes(origin)) return;

  throw forbidden('Request origin is not allowed.');
}

export async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw badRequest('Expected a JSON request body.');
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw badRequest('Request body was not valid JSON.');
  }
}

/** Hosts that legitimately answer over plain http: a local dev server. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

/**
 * True when this request reached us through Cloudflare's edge rather than a
 * local dev server.
 *
 * `cf-ray` is stamped by Cloudflare on every proxied request and overwritten if
 * a client sends its own, so it cannot be forged inward. `wrangler dev` does not
 * set it, which is exactly the distinction needed below — and the failure mode
 * if it were ever missing in production is that the upgrade is skipped, which is
 * merely today's behaviour rather than something worse.
 */
function fromCloudflareEdge(request: Request): boolean {
  return request.headers.has('cf-ray');
}

/**
 * Sends a plain-http request to the https address of the same URL, or null when
 * there is nothing to upgrade.
 *
 * This is not a hardening nicety. The session cookie is marked `Secure`, so a
 * browser silently discards it on an http response: signing in over http
 * appears to succeed and then lands back on the sign-in screen, with nothing in
 * the logs to explain it. Google refuses an http OAuth callback outright. Both
 * failures are invisible at the point they happen and both are fixed here.
 *
 * 308 rather than 301 because it preserves the method — a 301 turns a POST into
 * a GET, which would quietly discard the body of anything that reached us over
 * http rather than failing where somebody would notice.
 *
 * The edge check is not paranoia about dev convenience. `wrangler dev` rewrites
 * the incoming URL to the hostname in `[[routes]]` — the Worker sees
 * `http://app.cutthroughfaster.com` however you actually reached it — and then
 * rewrites the `Location` of the response back to the local address. Without the
 * check, every local request 308s to a URL that resolves back to itself, and
 * `npm run dev` becomes an infinite redirect.
 */
export function httpsUpgrade(request: Request, url: URL): Response | null {
  if (url.protocol === 'https:' || isLoopback(url.hostname)) return null;
  if (!fromCloudflareEdge(request)) return null;

  const secure = new URL(url);
  secure.protocol = 'https:';
  return new Response(null, {
    status: 308,
    headers: { location: secure.toString(), 'cache-control': 'no-store' },
  });
}

/**
 * A year of HSTS, so the browser stops trying http at all after the first
 * visit. The upgrade above only helps somebody who has already sent a request
 * in the clear; this stops the request being sent.
 *
 * Deliberately without `preload`: that submits the domain to a list browsers
 * ship in their binaries, and removal takes months. Not a decision to make as a
 * side effect of fixing a redirect.
 */
export const HSTS = 'max-age=31536000; includeSubDomains';

export function withTransportSecurity(url: URL, response: Response): Response {
  if (url.protocol !== 'https:' || isLoopback(url.hostname)) return response;
  // Headers on a Response from the assets runtime are immutable, so the header
  // is set on a copy rather than in place.
  const tagged = new Response(response.body, response);
  tagged.headers.set('strict-transport-security', HSTS);
  return tagged;
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}
