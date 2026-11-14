// JSON responses, errors, request bodies and the cross-site request check.

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code      the `error` field the client sees
   * @param {string} message   safe to show a visitor
   * @param {object} [extra]   extra body fields; `retryAfter` and `allow` also become headers
   */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const invalid = (field, message) => new HttpError(400, 'invalid', message, { field });
export const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message);
export const unreadable = () => new HttpError(400, 'invalid', 'That request could not be read.');
const tooLarge = () => new HttpError(413, 'too_large', 'That request is too large.');

export const MAX_BODY_BYTES = 8 * 1024;

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function errorResponse(error) {
  if (error instanceof HttpError) {
    const headers = {};
    const body = { ok: false, error: error.code, message: error.message };
    for (const [key, value] of Object.entries(error.extra)) {
      if (key === 'allow') headers.allow = value;
      else body[key] = value;
    }
    if (error.extra.retryAfter !== undefined) headers['retry-after'] = String(error.extra.retryAfter);
    return json(body, error.status, headers);
  }
  // Log the detail for the owner; never send it to the browser.
  console.error('unhandled_error', error && error.stack ? error.stack : error);
  return json(
    { ok: false, error: 'server_error', message: 'Something went wrong on our side. Please try again, or message us on WhatsApp.' },
    500,
  );
}

/**
 * State-changing requests must come from this site. Browsers always send
 * Origin on POST and DELETE; a missing or foreign one is refused.
 */
export function checkOrigin(request, url) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== url.origin) throw new HttpError(403, 'forbidden', 'This request was refused.');
}

/**
 * Reads a JSON object from the body: at most 8 KB (checked against the
 * declared length and the bytes that actually arrive), valid UTF-8, and an
 * object, not an array or a bare value. With `optional`, an empty body is {}.
 */
export async function readJson(request, { optional = false } = {}) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw tooLarge();
  if (optional && (!request.body || declared === '0')) return {};
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type', 'Send the request as JSON.');
  }
  const text = await readCapped(request);
  if (optional && text.trim() === '') return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw unreadable();
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw unreadable();
  return data;
}

async function readCapped(request) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw unreadable();
  }
}
