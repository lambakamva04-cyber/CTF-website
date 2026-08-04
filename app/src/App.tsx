import { useCallback, useEffect, useState } from 'react';
import type { MeResponse } from '../shared/types';
import { Spinner } from './components/ui';
import { api, ApiError } from './lib/api';
import { ChangePassword } from './pages/ChangePassword';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';

type Status = 'loading' | 'signed-out' | 'ready' | 'unavailable';

export default function App() {
  const [session, setSession] = useState<MeResponse | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  // The session lives in an HttpOnly cookie, so the only way to know whether
  // the client is signed in is to ask the server on load.
  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const result = await api.me(controller.signal);
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
    })();

    return () => controller.abort();
  }, []);

  const handleSignedIn = useCallback((next: MeResponse) => {
    setSession(next);
    setStatus('ready');
  }, []);

  const handleSignedOut = useCallback(() => {
    setSession(null);
    setStatus('signed-out');
  }, []);

  const handlePasswordChanged = useCallback(() => {
    setSession((previous) =>
      previous ? { ...previous, user: { ...previous.user, mustChangePassword: false } } : previous,
    );
  }, []);

  if (status === 'loading') {
    return (
      <div className="min-h-screen bg-white font-body flex items-center justify-center">
        <Spinner label="Loading your dashboard" />
      </div>
    );
  }

  if (status === 'unavailable') {
    return (
      <div className="min-h-screen bg-white text-black font-body flex items-center justify-center px-6">
        <div className="max-w-sm text-center space-y-4">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Dashboard unavailable
          </h1>
          <p className="text-sm text-gray-500">
            We could not reach the server. Your receptionist is still answering calls — this is
            only the dashboard.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="bg-black text-white rounded-xl px-5 py-2.5 text-sm font-medium hover:bg-gray-800 transition"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (status === 'signed-out' || !session) {
    return <Login onSignedIn={handleSignedIn} />;
  }

  if (session.user.mustChangePassword) {
    return <ChangePassword onDone={handlePasswordChanged} />;
  }

  return (
    <Dashboard
      session={session}
      onSignOut={handleSignedOut}
      onSessionExpired={handleSignedOut}
    />
  );
}
