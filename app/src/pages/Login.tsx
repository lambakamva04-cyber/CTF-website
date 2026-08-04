import { Loader2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { MeResponse } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { Banner } from '../components/ui';

/** Google's mark, inlined — a strict CSP blocks loading it from a CDN. */
function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

/** Reasons the Google leg can bounce back, phrased for the person reading them. */
const AUTH_ERRORS: Record<string, string> = {
  google_no_account:
    'That Google account is not linked to a login here. Ask whoever set up your dashboard to add it.',
  google_cancelled: 'Google sign-in was cancelled.',
  google_unverified:
    'That Google account has an unverified email address, so we cannot use it to sign in.',
  google_expired: 'That sign-in took too long. Please try again.',
  google_failed: 'Google sign-in did not complete. Please try again.',
  google_unavailable: 'Google sign-in is not set up for this dashboard yet.',
  account_disabled: 'That login has been disabled. Contact the owner of your dashboard.',
  no_org: 'That login is not linked to a business yet.',
};

export function Login({ onSignedIn }: { onSignedIn: (session: MeResponse) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  // Surface a failed Google round trip, then strip the parameter so a refresh
  // does not show a stale error.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('auth_error');
    if (!code) return;
    setError(AUTH_ERRORS[code] ?? 'Sign-in did not complete. Please try again.');
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void api
      .authMethods(controller.signal)
      .then((methods) => setGoogleEnabled(methods.google))
      .catch(() => setGoogleEnabled(false));
    return () => controller.abort();
  }, []);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const session = await api.login(email.trim(), password);
      onSignedIn(session);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not sign you in. Please try again.',
      );
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-white text-black font-body flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-2">
          <p className="text-xs tracking-widest uppercase text-gray-400 font-medium">
            Cut Through Faster
          </p>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Receptionist Dashboard
          </h1>
          <p className="text-sm text-gray-500">Sign in to see your calls as they happen.</p>
        </div>

        {error && <Banner tone="error">{error}</Banner>}

        {googleEnabled && (
          <>
            {/* A plain link, not fetch(): the OAuth flow is a top-level browser
                redirect, and an XHR to Google would be blocked by CORS. */}
            <a
              href="/api/auth/google/start"
              className="w-full border border-gray-200 rounded-xl py-3 text-sm font-medium flex items-center justify-center gap-2.5 hover:border-black transition"
            >
              <GoogleMark />
              Continue with Google
            </a>

            <div className="flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-gray-100" />
              <span className="text-xs text-gray-400">or</span>
              <span className="h-px flex-1 bg-gray-100" />
            </div>
          </>
        )}

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-gray-500">Email address</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="username"
              className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-black"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-gray-500">Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete="current-password"
              className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-black"
            />
          </label>

          <button
            type="submit"
            disabled={submitting || !email || !password}
            className="w-full bg-black text-white rounded-xl py-3 font-medium text-sm hover:bg-gray-800 transition flex items-center justify-center gap-2 disabled:opacity-40"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="text-xs text-gray-400 text-center">
          Trouble signing in? Contact Cut Through Faster and we will get you back in.
        </p>
      </div>
    </div>
  );
}
