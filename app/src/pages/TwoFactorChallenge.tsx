import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { MeResponse, TwoFactorChallenge as Challenge } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { Banner } from '../components/ui';
import { BrandShell, PrimaryButton } from '../components/Brand';

/**
 * The second step of signing in. The first factor has been accepted and no
 * session exists yet — everything here works against a challenge id, which on
 * its own grants nothing.
 */
export function TwoFactorChallenge({
  challenge,
  onVerified,
  onCancel,
}: {
  challenge: Challenge;
  onVerified: (session: MeResponse) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [current, setCurrent] = useState(challenge);

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, [useBackup]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const session = await api.verifyTwoFactor(
        current.challengeId,
        useBackup ? { backupCode: code } : { code },
      );
      onVerified(session);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'That did not work. Please try again.',
      );
      setCode('');
      setSubmitting(false);
      inputRef.current?.focus();
    }
  };

  const resend = async () => {
    setError(null);
    setNotice(null);
    try {
      const next = await api.resendTwoFactorCode(current.challengeId);
      setCurrent(next);
      setCode('');
      setNotice('A new code is on its way. The previous one no longer works.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not send another code.');
    }
  };

  const isEmail = current.method === 'email';

  return (
    <BrandShell>
      <div className="space-y-8">
        <div className="space-y-2">
          <p className="text-xs tracking-widest uppercase text-slate font-medium">
            Two-step verification
          </p>
          <h1 className="text-2xl font-semibold">
            {useBackup ? 'Enter a backup code' : 'Enter your code'}
          </h1>
          <p className="text-sm text-slate leading-relaxed">
            {useBackup
              ? 'Use one of the codes you saved when you switched this on. Each one works once.'
              : isEmail
                ? `We sent a six-digit code to ${current.sentTo ?? 'your email address'}. It expires in five minutes.`
                : 'Open your authenticator app and enter the six-digit code it shows.'}
          </p>
        </div>

        {error && <Banner tone="error">{error}</Banner>}
        {notice && !error && <Banner tone="info">{notice}</Banner>}

        <form onSubmit={submit} className="space-y-4" noValidate>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate">
              {useBackup ? 'Backup code' : 'Six-digit code'}
            </span>
            <input
              ref={inputRef}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              // inputMode drives the numeric keypad on a phone, which is where
              // most of these are typed. autoComplete lets iOS and Android
              // offer the code straight from the SMS/email notification.
              inputMode={useBackup ? 'text' : 'numeric'}
              autoComplete={useBackup ? 'off' : 'one-time-code'}
              maxLength={useBackup ? 12 : 7}
              required
              className="w-full border border-field rounded-xl px-4 py-3 text-lg font-mono-data tracking-[0.3em] text-center focus:outline-none focus:border-black"
            />
          </label>

          <PrimaryButton type="submit" disabled={submitting || code.trim().length < 6}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {submitting ? 'Checking…' : 'Verify and sign in'}
          </PrimaryButton>
        </form>

        <div className="flex flex-col gap-2 text-xs text-slate text-center">
          {isEmail && !useBackup && (
            <button type="button" onClick={() => void resend()} className="underline underline-offset-2">
              Send another code
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setUseBackup((previous) => !previous);
              setCode('');
              setError(null);
            }}
            className="underline underline-offset-2"
          >
            {useBackup ? 'Use my code instead' : 'I cannot get a code — use a backup code'}
          </button>
          <button type="button" onClick={onCancel} className="underline underline-offset-2">
            Cancel and start again
          </button>
        </div>
      </div>
    </BrandShell>
  );
}
