import 'server-only';

export type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413 | 415; error: 'invalid_body' | 'too_large' | 'unsupported' };

/**
 * Reads a JSON body of at most `maxBytes`.
 *
 * Every body these routes accept is a handful of short fields, so anything
 * larger is refused before it is parsed: a declared length is checked first,
 * and the stream is counted as it arrives, since a sender can leave the length
 * out. Without this a single request could make the Worker buffer and parse
 * up to Cloudflare's own ceiling of 100 MB.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<BodyResult> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return { ok: false, status: 415, error: 'unsupported' };
  }

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413, error: 'too_large' };
  }

  let text = '';
  if (request.body) {
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, error: 'too_large' };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, error: 'invalid_body' };
  }
}
