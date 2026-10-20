import { NextResponse, type NextRequest } from 'next/server';

/**
 * HTTP Basic Auth for the internal /admin analytics dashboard.
 *
 * The dashboard exposes prospect names and outreach status, so it must never be
 * public on the demo site. Credentials live in ADMIN_USER / ADMIN_PASS (Worker
 * secrets). This fails CLOSED: if either secret is unset, or the header is
 * missing or wrong, the dashboard is never served — a locked door beats an open
 * one. A 401 with WWW-Authenticate makes the browser prompt for credentials.
 */
export const config = { matcher: ['/admin', '/admin/:path*'] };

function unauthorized(): NextResponse {
  return new NextResponse('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="CTF admin", charset="UTF-8"',
      'cache-control': 'no-store',
    },
  });
}

/** Length-independent comparison, so neither value leaks through timing. */
function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length);
  return diff === 0;
}

export function middleware(request: NextRequest): NextResponse {
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASS;
  if (!user || !pass) return unauthorized();

  const header = request.headers.get('authorization');
  if (!header || !header.startsWith('Basic ')) return unauthorized();

  let decoded: string;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return unauthorized();
  }

  const sep = decoded.indexOf(':');
  const givenUser = sep === -1 ? decoded : decoded.slice(0, sep);
  const givenPass = sep === -1 ? '' : decoded.slice(sep + 1);

  const ok = safeEqual(givenUser, user) && safeEqual(givenPass, pass);
  return ok ? NextResponse.next() : unauthorized();
}
