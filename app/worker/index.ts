import type { Env } from './env';
import { pruneExpired, requireAuth, type AuthContext } from './lib/auth';
import { assertTrustedOrigin, errorResponse, forbidden, json, notFound } from './lib/http';
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
import { handleMetrics } from './routes/metrics';
import { handleVapiWebhook } from './routes/webhook';

/**
 * Routes a client user must be able to reach even while their password is
 * flagged for rotation — everything else is withheld until they change it.
 */
const PASSWORD_ROTATION_ALLOWLIST = new Set(['/api/me', '/api/auth/password', '/api/auth/logout']);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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
    return handleVapiWebhook(request, env);
  }

  assertTrustedOrigin(request, env);

  if (path === '/api/auth/login') {
    if (method !== 'POST') return methodNotAllowed('POST');
    return handleLogin(request, env);
  }

  const auth = await requireAuth(request, env);

  if (auth.user.must_change_password === 1 && !PASSWORD_ROTATION_ALLOWLIST.has(path)) {
    throw forbidden('Please choose a new password before continuing.');
  }

  // Opportunistic cleanup; runs after the response is already on its way.
  if (Math.random() < 0.01) ctx.waitUntil(pruneExpired(env));

  if (path === '/api/me' && method === 'GET') return handleMe(auth);
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
  return env.ASSETS.fetch(new Request(new URL('/', url), request));
}
