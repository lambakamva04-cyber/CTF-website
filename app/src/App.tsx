import { useCallback, useEffect, useState } from 'react';
import type { LegalDocumentId } from '../shared/legal';
import type { MeResponse, TwoFactorChallenge as Challenge } from '../shared/types';
import { BrandShell } from './components/Brand';
import { DashboardSkeleton } from './components/Skeleton';
import { api, ApiError } from './lib/api';
import { AcceptTerms } from './pages/AcceptTerms';
import { AdminConsole } from './pages/AdminConsole';
import { ChangePassword } from './pages/ChangePassword';
import { Dashboard } from './pages/Dashboard';
import { Legal } from './pages/Legal';
import { Login } from './pages/Login';
import { PendingApproval } from './pages/PendingApproval';
import { Signup } from './pages/Signup';
import { TwoFactorChallenge } from './pages/TwoFactorChallenge';

type Status = 'loading' | 'signed-out' | 'ready' | 'unavailable';

/**
 * Routing is a handful of paths matched by hand rather than a router library.
 * The app has four public screens and one private one; a router would be a
 * dependency and a bundle cost for something this shape.
 */
type Route = LegalDocumentId | 'signup' | 'app';

function currentRoute(): Route {
  const path = window.location.pathname;
  if (path === '/terms') return 'terms';
  if (path === '/privacy') return 'privacy';
  if (path === '/operator') return 'operator';
  if (path === '/signup') return 'signup';
  return 'app';
}

function isLegalRoute(route: Route): route is LegalDocumentId {
  return route === 'terms' || route === 'privacy' || route === 'operator';
}

export default function App() {
  const [session, setSession] = useState<MeResponse | null>(null);
  // A sign-in that has passed the first factor and is waiting on a code. The
  // Google leg is a browser redirect with no response body, so it hands the
  // challenge back in the URL; the password leg returns it in JSON.
  const [challenge, setChallenge] = useState<Challenge | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('challenge');
    const method = params.get('method');
    if (!id || (method !== 'totp' && method !== 'email')) return null;
    window.history.replaceState({}, '', window.location.pathname);
    return { twoFactorRequired: true, challengeId: id, method, sentTo: params.get('sent_to') };
  });
  const [status, setStatus] = useState<Status>('loading');
  const [route, setRoute] = useState(currentRoute);

  const navigate = useCallback((path: string) => {
    window.history.pushState({}, '', path);
    setRoute(currentRoute());
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(currentRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // The session lives in an HttpOnly cookie, so the only way to know whether
  // the client is signed in is to ask the server on load.
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await api.me(signal);
      setSession(result);
      setStatus('ready');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setStatus('signed-out');
        return;
      }
      setStatus('unavailable');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const handleSignedIn = useCallback((next: MeResponse) => {
    setChallenge(null);
    setSession(next);
    setStatus('ready');
  }, []);

  const handleSignedOut = useCallback(() => {
    setSession(null);
    setStatus('signed-out');
  }, []);

  // The policies are readable without an account — someone deciding whether to
  // sign up needs to read them before they have one.
  if (isLegalRoute(route)) {
    return <Legal document={route} onBack={() => navigate('/')} />;
  }

  // The first thing a client sees on every visit. Drawing the dashboard's own
  // layout — heading, live card, the three figures, the call list — rather than
  // a spinner means the page they are waiting for is already the page they are
  // looking at, and nothing moves when the data lands.
  if (status === 'loading') {
    return <DashboardSkeleton />;
  }

  if (status === 'unavailable') {
    return (
      <BrandShell>
        <div className="space-y-4 text-center">
          <h1 className="text-2xl font-semibold">Dashboard unavailable</h1>
          <p className="text-sm text-slate">
            We could not reach the server. Your receptionist is still answering calls — this is
            only the dashboard.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="bg-ink text-cream rounded-lg px-5 py-2.5 text-sm font-medium hover:bg-ink-soft transition"
          >
            Try again
          </button>
        </div>
      </BrandShell>
    );
  }

  if (status === 'signed-out' || !session) {
    if (challenge) {
      return (
        <TwoFactorChallenge
          challenge={challenge}
          onVerified={handleSignedIn}
          onCancel={() => setChallenge(null)}
        />
      );
    }
    if (route === 'signup') return <Signup onBackToSignIn={() => navigate('/')} />;
    return (
      <Login
        onSignedIn={handleSignedIn}
        onChallenge={setChallenge}
        onSignUp={() => navigate('/signup')}
      />
    );
  }

  // Order matters: consent is asked for before anything else, an inactive
  // organization is told so before it sees an empty dashboard, and a password
  // flagged for rotation is replaced before the product is reachable.
  if (!session.user.termsAccepted) {
    return <AcceptTerms onAccepted={() => void refresh()} />;
  }

  if (session.org.status !== 'active' && !session.user.isPlatformAdmin) {
    return <PendingApproval session={session} onSignOut={handleSignedOut} />;
  }

  if (session.user.mustChangePassword) {
    return (
      <ChangePassword
        onDone={() =>
          setSession((previous) =>
            previous
              ? { ...previous, user: { ...previous.user, mustChangePassword: false } }
              : previous,
          )
        }
      />
    );
  }

  // A CTF admin oversees the platform; they do not get a client's dashboard,
  // not even their own organization's. The server refuses those routes too.
  if (session.user.isPlatformAdmin) {
    return (
      <AdminConsole
        session={session}
        onSignOut={handleSignedOut}
        onSessionExpired={handleSignedOut}
      />
    );
  }

  return (
    <Dashboard
      session={session}
      onSignOut={handleSignedOut}
      onSessionExpired={handleSignedOut}
    />
  );
}
