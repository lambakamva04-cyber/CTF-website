import {
  BREACH_NOTIFICATION_HOURS,
  CURRENT_VERSIONS,
  INFORMATION_OFFICER,
  LEGAL_DOCUMENTS,
  SUB_PROCESSORS,
} from '../shared/legal';
import type { Env } from './env';
import { pruneExpired, requireAuth, type AuthContext } from './lib/auth';
import {
  assertTrustedOrigin,
  clientIp,
  errorResponse,
  forbidden,
  json,
  notFound,
} from './lib/http';
import {
  enforce,
  READ_RULE,
  subjectFor,
  TWO_FACTOR_RULE,
  WEBHOOK_RULE,
  WRITE_RULE,
} from './lib/rateLimit';
import {
  handleAcceptTerms,
  handleSignupStart,
  hasCurrentConsent,
} from './routes/signup';
import {
  handlePlatformOverview,
  handlePlatformSetOrgStatus,
} from './routes/platform';
import {
  handleChangePassword,
  handleLogin,
  handleLogout,
  handleMe,
} from './routes/auth';
import {
  handleEndCall,
  handleGetCall,
  handleListCalls,
  handleLiveCall,
  handleTakeover,
  handleTranscript,
} from './routes/calls';
import {
  googleAvailability,
  handleGoogleCallback,
  handleGoogleStart,
} from './routes/googleAuth';
import { handleMetrics } from './routes/metrics';
import {
  handleChallengeResend,
  handleChallengeVerify,
  handleEmailFactorEnable,
  handleRegenerateBackupCodes,
  handleTotpEnrollConfirm,
  handleTotpEnrollStart,
  handleTwoFactorDisable,
  handleTwoFactorStatus,
} from './routes/twoFactor';
import { canonicalFor, canonicalOrigin, robotsTagFor, sitemapXml } from './lib/seo';
import {
  handleCreateTeamMember,
  handleListTeam,
  handleUpdateTeamMember,
} from './routes/users';
import { handleVapiWebhook } from './routes/webhook';

/**
 * Routes a client user must be able to reach even while their password is
 * flagged for rotation — everything else is withheld until they change it.
 */
const PASSWORD_ROTATION_ALLOWLIST = new Set(['/api/me', '/api/auth/password', '/api/auth/logout']);

/**
 * Reachable while an organization is pending approval or suspended. Everything
 * else — every route that touches call data — is closed. A pending client can
 * sign in and see that they are waiting; they cannot see the product.
 */
const INACTIVE_ORG_ALLOWLIST = new Set([
  '/api/me',
  '/api/auth/logout',
  '/api/auth/accept-terms',
  '/api/platform/overview',
]);

/** Reachable before the current policy versions have been accepted. */
const CONSENT_ALLOWLIST = new Set(['/api/me', '/api/auth/logout', '/api/auth/accept-terms']);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Ahead of serveSpa, which would otherwise treat the extension as a file
    // and hand it to the assets runtime, where no such file exists.
    if (url.pathname === '/sitemap.xml') {
      return new Response(sitemapXml(canonicalOrigin(env, url)), {
        headers: {
          'content-type': 'application/xml; charset=utf-8',
          'cache-control': 'public, max-age=3600',
        },
      });
    }

    if (!url.pathname.startsWith('/api/')) {
      return serveSpa(request, env, url);
    }

    try {
      return await handleApi(request, env, ctx, url);
    } catch (error) {
      return errorResponse(error);
    }
  },

  /** Nightly housekeeping for sessions, rate-limit rows and webhook ids. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(pruneExpired(env));
  },
};

async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === '/api/health') {
    return json({ ok: true, time: Date.now() });
  }

  // Vapi signs webhooks with a shared secret rather than a browser origin, so
  // it is authenticated inside the handler instead of by the CSRF check.
  if (path === '/api/vapi/webhook') {
    if (method !== 'POST') return methodNotAllowed('POST');
    // Loose enough not to drop events on a busy line — a dropped webhook loses
    // a transcript line permanently — but bounded against a runaway loop.
    await enforce(env, `ip:${clientIp(request)}`, WEBHOOK_RULE);
    return handleVapiWebhook(request, env);
  }

  if (path === '/api/legal' && method === 'GET') {
    return json({
      documents: LEGAL_DOCUMENTS,
      versions: CURRENT_VERSIONS,
      subProcessors: SUB_PROCESSORS,
      informationOfficer: INFORMATION_OFFICER,
      breachNotificationHours: BREACH_NOTIFICATION_HOURS,
    });
  }

  // Which sign-in methods this deployment offers. Public: the answer is visible
  // on the sign-in screen anyway, and it carries no account information.
  if (path === '/api/auth/methods' && method === 'GET') {
    return json(googleAvailability(env, url));
  }

  // The Google leg is driven by top-level browser redirects, not fetch(), so
  // there is no Origin header to check. CSRF is handled instead by the
  // single-use `state` issued at /start and redeemed at /callback.
  if (path === '/api/auth/google/start') {
    if (method !== 'GET') return methodNotAllowed('GET');
    return handleGoogleStart(request, env);
  }
  if (path === '/api/auth/google/callback') {
    if (method !== 'GET') return methodNotAllowed('GET');
    return handleGoogleCallback(request, env);
  }

  assertTrustedOrigin(request, env);

  if (path === '/api/auth/login') {
    if (method !== 'POST') return methodNotAllowed('POST');
    return handleLogin(request, env);
  }

  if (path === '/api/auth/signup/start') {
    if (method !== 'POST') return methodNotAllowed('POST');
    return handleSignupStart(request, env);
  }

  // Answering a second-factor challenge. Unauthenticated by necessity — there
  // is no session cookie until the code is right — so it is limited by address
  // as well as by the per-challenge attempt cap.
  if (path === '/api/auth/2fa/verify' || path === '/api/auth/2fa/resend') {
    if (method !== 'POST') return methodNotAllowed('POST');
    await enforce(
      env,
      `ip:${clientIp(request)}`,
      TWO_FACTOR_RULE,
      'Too many code attempts from this connection. Please wait and try again.',
    );
    return path === '/api/auth/2fa/verify'
      ? handleChallengeVerify(request, env)
      : handleChallengeResend(request, env);
  }

  const auth = await requireAuth(request, env);

  // Limited as the user rather than the address, so one client on a shared
  // office connection cannot exhaust another's budget.
  await enforce(
    env,
    subjectFor(auth.user.id, clientIp(request)),
    method === 'GET' ? READ_RULE : WRITE_RULE,
  );

  if (auth.user.must_change_password === 1 && !PASSWORD_ROTATION_ALLOWLIST.has(path)) {
    throw forbidden('Please choose a new password before continuing.');
  }

  // CTF staff are exempt from the organization gate: their own organization's
  // status must not determine whether they can see the platform overview.
  const isPlatformAdmin = auth.user.platform_role === 'ctf_admin';

  if (!isPlatformAdmin && auth.org.status !== 'active' && !INACTIVE_ORG_ALLOWLIST.has(path)) {
    throw forbidden(
      auth.org.status === 'pending'
        ? 'Your account is waiting to be activated by Cut Through Faster.'
        : 'This account has been suspended. Please contact Cut Through Faster.',
    );
  }

  if (!CONSENT_ALLOWLIST.has(path) && !(await hasCurrentConsent(env, auth.user.id))) {
    throw forbidden('Please accept the updated terms and privacy policy to continue.');
  }

  // Opportunistic cleanup; runs after the response is already on its way.
  if (Math.random() < 0.01) ctx.waitUntil(pruneExpired(env));

  if (path === '/api/me' && method === 'GET') {
    return handleMe(auth, await hasCurrentConsent(env, auth.user.id));
  }
  if (path === '/api/auth/accept-terms') {
    if (method !== 'POST') return methodNotAllowed('POST');
    return handleAcceptTerms(request, env, auth);
  }
  if (path === '/api/auth/2fa' && method === 'GET') {
    return handleTwoFactorStatus(env, auth);
  }
  if (path === '/api/auth/2fa/totp/start') {
    if (method !== 'POST') return methodNotAllowed('POST');
    return handleTotpEnrollStart(request, env, auth);
  }
  if (path === '/api/auth/2fa/totp/confirm') {
    if (method !== 'POST') return methodNotAllowed('POST');
    return handleTotpEnrollConfirm(request, env, auth);
  }
  if (path === '/api/auth/2fa/email/enable') {
    if (method !== 'POST') return methodNotAllowed('POST');
    return handleEmailFactorEnable(request, env, auth);
  }
  if (path === '/api/auth/2fa/disable') {
    if (method !== 'POST') return methodNotAllowed('POST');
    return handleTwoFactorDisable(request, env, auth);
  }
  if (path === '/api/auth/2fa/backup-codes') {
    if (method !== 'POST') return methodNotAllowed('POST');
    return handleRegenerateBackupCodes(request, env, auth);
  }

  if (path === '/api/platform/overview' && method === 'GET') {
    return handlePlatformOverview(request, env, auth);
  }

  const platformOrgMatch = /^\/api\/platform\/organizations\/([^/]+)$/.exec(path);
  if (platformOrgMatch) {
    if (method !== 'PATCH') return methodNotAllowed('PATCH');
    return handlePlatformSetOrgStatus(
      request,
      env,
      auth,
      decodeURIComponent(platformOrgMatch[1] as string),
    );
  }
  if (path === '/api/auth/logout') {
    if (method !== 'POST') return methodNotAllowed('POST');
    return handleLogout(request, env, auth);
  }
  if (path === '/api/auth/password') {
    if (method !== 'POST') return methodNotAllowed('POST');
    return handleChangePassword(request, env, auth);
  }
  if (path === '/api/metrics' && method === 'GET') return handleMetrics(request, env, auth);
  if (path === '/api/calls' && method === 'GET') return handleListCalls(request, env, auth);
  if (path === '/api/calls/live' && method === 'GET') return handleLiveCall(env, auth);

  if (path === '/api/users') {
    if (method === 'GET') return handleListTeam(env, auth);
    if (method === 'POST') return handleCreateTeamMember(request, env, auth);
    return methodNotAllowed('GET, POST');
  }

  const userMatch = /^\/api\/users\/([^/]+)$/.exec(path);
  if (userMatch) {
    if (method !== 'PATCH') return methodNotAllowed('PATCH');
    return handleUpdateTeamMember(request, env, auth, decodeURIComponent(userMatch[1] as string));
  }

  const callRoute = matchCallRoute(path);
  if (callRoute) return routeCall(request, env, auth, method, callRoute);

  throw notFound('That endpoint does not exist.');
}

interface CallRoute {
  callId: string;
  action: 'detail' | 'transcript' | 'takeover' | 'end';
}

function matchCallRoute(path: string): CallRoute | null {
  const segments = path.split('/').filter(Boolean); // ['api', 'calls', ':id', ...]
  if (segments.length < 3 || segments[0] !== 'api' || segments[1] !== 'calls') return null;

  const callId = decodeURIComponent(segments[2] as string);
  if (!callId) return null;

  if (segments.length === 3) return { callId, action: 'detail' };
  if (segments.length !== 4) return null;

  const action = segments[3];
  if (action === 'transcript' || action === 'takeover' || action === 'end') {
    return { callId, action };
  }
  return null;
}

function routeCall(
  request: Request,
  env: Env,
  auth: AuthContext,
  method: string,
  route: CallRoute,
): Promise<Response> | Response {
  switch (route.action) {
    case 'detail':
      if (method !== 'GET') return methodNotAllowed('GET');
      return handleGetCall(env, auth, route.callId);
    case 'transcript':
      if (method !== 'GET') return methodNotAllowed('GET');
      return handleTranscript(request, env, auth, route.callId);
    case 'takeover':
      if (method !== 'POST') return methodNotAllowed('POST');
      return handleTakeover(request, env, auth, route.callId);
    case 'end':
      if (method !== 'POST') return methodNotAllowed('POST');
      return handleEndCall(request, env, auth, route.callId);
  }
}

function methodNotAllowed(allow: string): Response {
  return json(
    { error: 'method_not_allowed', message: `Use ${allow} for this endpoint.` },
    { status: 405, headers: { allow } },
  );
}

/**
 * Serves built assets, falling back to index.html so client-side routes survive
 * a refresh or a deep link.
 *
 * A path is treated as a file request only when it has an extension. Anything
 * else gets the SPA shell served in place — the assets runtime would otherwise
 * answer an unknown path with a redirect to `/`, throwing away the route the
 * client asked for.
 */
async function serveSpa(request: Request, env: Env, url: URL): Promise<Response> {
  const looksLikeFile = /\.[a-z0-9]+$/i.test(url.pathname);
  if (looksLikeFile) return env.ASSETS.fetch(request);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  // Ask for `/`, not `/index.html`: the assets runtime canonicalises the
  // latter with a 307 redirect rather than serving it.
  const response = await env.ASSETS.fetch(new Request(new URL('/', url), request));

  // Every client route is served from the same HTML shell, so a `noindex` meta
  // tag in that file would hide the legal pages along with the dashboard. The
  // decision has to be made per URL, which means a header.
  const robots = robotsTagFor(url.pathname);
  const canonical = canonicalFor(canonicalOrigin(env, url), url.pathname);
  if (!robots && !canonical) return response;

  const tagged = new Response(response.body, response);
  if (robots) tagged.headers.set('x-robots-tag', robots);
  // Sent as a header rather than a meta tag because the SPA serves one HTML
  // file for every route — the tag cannot differ per URL, and the header can.
  if (canonical) tagged.headers.set('link', `<${canonical}>; rel="canonical"`);
  return tagged;
}
