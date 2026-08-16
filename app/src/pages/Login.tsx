import { Loader2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { MeResponse, TwoFactorChallenge } from '../../shared/types';
import { isTwoFactorChallenge } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { Banner } from '../components/ui';
import { BrandShell } from '../components/Brand';
import { GoogleMark } from '../components/GoogleMark';
import { Skeleton, SkeletonRegion } from '../components/Skeleton';

/** Reasons the Google leg can bounce back, phrased for the person reading them. */
const AUTH_ERRORS: Record<string, string> = {
  google_no_account:
    'That Google account is not linked to a login here. Ask whoever set up your dashboard to add it.',
  google_cancelled: 'Google sign-in was cancelled.',
  google_unverified:
    'That Google account has an unverified email address, so we cannot use it to sign in.',
  google_expired: 'That sign-in took too long. Please try again.',
  google_failed: 'Google sign-in did not complete. Please try again.',

  // Configuration faults. Worded so whoever set the dashboard up knows exactly
  // which control to check, rather than being told to "try again" forever.
  google_token_exchange:
    'Google refused to complete the sign-in. The client secret on this dashboard is most likely wrong or out of date.',
  google_audience:
    'Google signed you in for a different application. The client ID on this dashboard does not match the one that issued the sign-in.',
  google_token_malformed: 'Google returned a response we could not read. Please try again.',
  google_issuer: 'That sign-in did not come from Google. Please try again.',
  google_nonce: 'That sign-in could not be matched to this browser. Please try again.',
  google_missing_email: 'Google did not share an email address, so we cannot match your login.',
  google_unavailable: 'Google sign-in is not set up for this dashboard yet.',
  account_disabled: 'That login has been disabled. Contact the owner of your dashboard.',
  no_org: 'That login is not linked to a business yet.',
  signup_failed: 'We could not finish creating your account. Please try again.',
};

export function Login({
  onSignedIn,
  onChallenge,
  onSignUp,
}: {
  onSignedIn: (session: MeResponse) => void;
  onChallenge: (challenge: TwoFactorChallenge) => void;
  onSignUp: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Three states, not two. Until the server has answered we do not know whether
  // this deployment offers Google, and rendering `false` in the meantime pops
  // the button and the divider into existence a moment later — on the screen a
  // client sees most often.
  const [googleEnabled, setGoogleEnabled] = useState<boolean | null>(null);

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
      const result = await api.login(email.trim(), password);
      // The password being right is not the same as being signed in. When the
      // account carries a second factor the server returns a challenge and no
      // cookie, and the caller takes over from there.
      if (isTwoFactorChallenge(result)) {
        setPassword('');
        onChallenge(result);
        return;
      }
      onSignedIn(result);
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
    <BrandShell>
      <div className="space-y-8">
        <div className="space-y-2">
          <p className="text-xs tracking-widest uppercase text-slate font-medium">
            Receptionist Dashboard
          </p>
          <h1 className="text-2xl font-semibold">Sign in</h1>
          <p className="text-sm text-slate">See your calls as they happen.</p>
        </div>

        {error && <Banner tone="error">{error}</Banner>}

        {googleEnabled === null && (
          <SkeletonRegion label="Checking which sign-in methods are available" className="space-y-8">
            <Skeleton className="h-12 w-full rounded-xl" />
            {/* The divider it stands in for is a hairline with "or" on it, so
                the placeholder is a hairline too — a solid bar here would be
                heavier than the thing that replaces it. */}
            <span className="flex items-center h-4">
              <Skeleton className="h-px w-full" delay={1} />
            </span>
          </SkeletonRegion>
        )}

        {googleEnabled === true && (
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

        <p className="text-xs text-slate text-center">
          New to Cut Through Faster?{' '}
          <button
            type="button"
            onClick={onSignUp}
            className="underline underline-offset-2 text-ink font-medium"
          >
            Register your business
          </button>
        </p>

        <p className="text-xs text-slate text-center">
          By signing in you accept our{' '}
          <a href="/terms" className="underline underline-offset-2">
            Terms
          </a>{' '}
          ,{' '}
          <a href="/privacy" className="underline underline-offset-2">
            Privacy Policy
          </a>{' '}
          and{' '}
          <a href="/operator" className="underline underline-offset-2">
            Operator Agreement
          </a>
          .
        </p>
      </div>
    </BrandShell>
  );
}
