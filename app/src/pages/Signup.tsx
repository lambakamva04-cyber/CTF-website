import { Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { Banner } from '../components/ui';
import { BrandShell, PrimaryButton, TextField } from '../components/Brand';
import { GoogleMark } from '../components/GoogleMark';

/**
 * Registering an organization. Google confirms the email before anything is
 * created, so the business name and consent are collected first and held
 * server-side across the round trip.
 */
export function Signup({ onBackToSignIn }: { onBackToSignIn: () => void }) {
  const [orgName, setOrgName] = useState('');
  const [note, setNote] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting || !accepted) return;

    setSubmitting(true);
    setError(null);
    try {
      const { authorizeUrl } = await api.startSignup(orgName.trim(), note.trim());
      window.location.href = authorizeUrl;
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not start signup. Please try again.',
      );
      setSubmitting(false);
    }
  };

  return (
    <BrandShell>
      <div className="space-y-8">
        <div className="space-y-2">
          <p className="text-xs tracking-widest uppercase text-slate font-medium">
            Create an account
          </p>
          <h1 className="text-2xl font-semibold">Set up your dashboard</h1>
          <p className="text-sm text-slate">
            Register your business, then a member of the Cut Through Faster team activates it.
            You will be able to sign in straight away and will see your calls once it is live.
          </p>
        </div>

        {error && <Banner tone="error">{error}</Banner>}

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <TextField
            label="Business name"
            value={orgName}
            onChange={(event) => setOrgName(event.target.value)}
            placeholder="Riverside Dental Studio"
            required
            maxLength={80}
            autoFocus
          />

          <TextField
            label="Anything we should know? (optional)"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Two practices, one number"
            maxLength={500}
          />

          <label className="flex items-start gap-2.5 pt-1">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[#14161A]"
            />
            <span className="text-xs text-slate leading-relaxed">
              I accept the{' '}
              <a href="/terms" target="_blank" rel="noreferrer" className="underline underline-offset-2 text-ink">
                Terms of Service
              </a>
              , the{' '}
              <a href="/privacy" target="_blank" rel="noreferrer" className="underline underline-offset-2 text-ink">
                Privacy Policy
              </a>{' '}
              and the{' '}
              <a href="/operator" target="_blank" rel="noreferrer" className="underline underline-offset-2 text-ink">
                Operator Agreement
              </a>
              , including that Cut Through Faster records how many calls and bookings my
              receptionist handles in order to bill me. I am signing the operator agreement on
              behalf of my business.
            </span>
          </label>

          <PrimaryButton type="submit" disabled={submitting || !accepted || orgName.trim().length < 2}>
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <GoogleMark />
            )}
            {submitting ? 'Redirecting…' : 'Continue with Google'}
          </PrimaryButton>
        </form>

        <p className="text-xs text-slate text-center">
          Already have an account?{' '}
          <button
            type="button"
            onClick={onBackToSignIn}
            className="underline underline-offset-2 text-ink"
          >
            Sign in
          </button>
        </p>
      </div>
    </BrandShell>
  );
}
