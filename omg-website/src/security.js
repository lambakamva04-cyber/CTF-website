// Security headers for every response: pages, images, scripts and the API.

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // The fonts are this site's own files (public/fonts/): no other server is needed.
  "font-src 'self'",
  "img-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
  "manifest-src 'self'",
];

const isAdminPath = (path) => path === '/admin' || path.startsWith('/admin/');
const isApiPath = (path) => path === '/api' || path.startsWith('/api/');

/** The headers for a response to `url`. */
export function securityHeaders(url) {
  const https = url.protocol === 'https:';
  const headers = {
    // upgrade-insecure-requests would break plain-http local development.
    'content-security-policy': (https ? [...CSP, 'upgrade-insecure-requests'] : CSP).join('; '),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'cross-origin-opener-policy': 'same-origin',
  };
  if (https) headers['strict-transport-security'] = 'max-age=31536000';
  if (isAdminPath(url.pathname)) {
    headers['x-robots-tag'] = 'noindex, nofollow';
    headers['cache-control'] = 'no-store';
  } else if (isApiPath(url.pathname)) {
    headers['x-robots-tag'] = 'noindex, nofollow';
  }
  return headers;
}

/** A copy of `response` with the security headers set (status and body kept). */
export function withSecurityHeaders(response, url) {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(securityHeaders(url))) out.headers.set(name, value);
  if ((url.pathname.startsWith('/img/') || url.pathname.startsWith('/fonts/')) && out.status === 200) {
    out.headers.set('cache-control', 'public, max-age=604800');
  }
  return out;
}
