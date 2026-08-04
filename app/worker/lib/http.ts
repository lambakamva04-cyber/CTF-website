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

export function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}
