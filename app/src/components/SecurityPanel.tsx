import { KeyRound, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { TwoFactorStatus } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { QrCode } from './QrCode';
import { TableSkeleton } from './Skeleton';
import { Banner } from './ui';

type Stage =
  | { kind: 'idle' }
  | { kind: 'enrolling'; secret: string; otpauthUri: string }
  | { kind: 'codes'; codes: string[] }
  | { kind: 'disabling' };

/**
 * The account holder's own security settings.
 *
 * `adminMode` is for CTF admin accounts: only the authenticator app is
 * offered, and there is no way to turn it off. The server refuses both anyway;
 * this keeps the screen from offering what it would refuse.
 */
export function SecurityPanel({ adminMode = false }: { adminMode?: boolean } = {}) {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const codesHeadingRef = useRef<HTMLHeadingElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);
  const enrolHelpId = useId();
  const enrolKeyId = useId();
  const disableHelpId = useId();

  // Each stage replaces the button that led to it, which would drop keyboard
  // focus to the top of the page. Send it to where the next step begins.
  const previousStage = useRef(stage.kind);
  useEffect(() => {
    if (previousStage.current === stage.kind) return;
    previousStage.current = stage.kind;
    if (stage.kind === 'enrolling' || stage.kind === 'disabling') codeInputRef.current?.focus();
    else if (stage.kind === 'codes') codesHeadingRef.current?.focus();
    else headingRef.current?.focus();
  }, [stage.kind]);

  const load = useCallback(async () => {
    try {
      setStatus(await api.twoFactorStatus());
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load your settings.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const startTotp = () =>
    run(async () => {
      const enrollment = await api.startTotpEnrollment();
      setCode('');
      setStage({ kind: 'enrolling', ...enrollment });
    });

  const confirmTotp = () =>
    run(async () => {
      const { backupCodes } = await api.confirmTotpEnrollment(code);
      setCode('');
      setStage({ kind: 'codes', codes: backupCodes });
      await load();
    });

  const enableEmail = () =>
    run(async () => {
      const { backupCodes } = await api.enableEmailFactor();
      setStage({ kind: 'codes', codes: backupCodes });
      await load();
    });

  const disable = () =>
    run(async () => {
      await api.disableTwoFactor(code);
      setCode('');
      setStage({ kind: 'idle' });
      await load();
    });

  const regenerate = () =>
    run(async () => {
      const { backupCodes } = await api.regenerateBackupCodes();
      setStage({ kind: 'codes', codes: backupCodes });
      await load();
    });

  const enabled = status && status.method !== 'none';

  return (
    <section className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <h2 ref={headingRef} tabIndex={-1} className="font-display text-lg font-semibold focus:outline-none">
          Security
        </h2>
        {status && (
          <span
            className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border ${
              enabled ? 'border-black' : 'border-gray-200 text-slate'
            }`}
          >
            {enabled ? (
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {enabled
              ? status.method === 'totp'
                ? 'Authenticator app'
                : 'Email codes'
              : 'Two-step off'}
          </span>
        )}
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      {!status ? (
        <TableSkeleton label="Loading your security settings" rows={2} />
      ) : stage.kind === 'codes' ? (
        <div className="border-2 border-ink rounded-xl p-5 space-y-3 bg-cream-dim/40">
          <h3
            ref={codesHeadingRef}
            tabIndex={-1}
            className="text-[0.65rem] tracking-widest uppercase font-semibold focus:outline-none"
          >
            Save these now — they are not shown again
          </h3>
          <p className="text-sm text-slate leading-relaxed">
            Each code signs you in once if you lose your phone. There is no other way back into
            your account, so print them or put them somewhere safe before you close this.
          </p>
          <ul className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono-data text-sm">
            {stage.codes.map((backup) => (
              <li key={backup}>{backup}</li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setStage({ kind: 'idle' })}
            className="text-xs underline underline-offset-2"
          >
            I have saved them
          </button>
        </div>
      ) : stage.kind === 'enrolling' ? (
        <div className="border border-line rounded-xl p-5 space-y-4">
          <p id={enrolHelpId} className="text-sm text-slate leading-relaxed">
            Scan this with Google Authenticator, 1Password, or any authenticator app, then enter
            the six-digit code it shows.
          </p>
          <div className="flex flex-col sm:flex-row gap-5 items-start">
            <QrCode value={stage.otpauthUri} size={180} />
            <div className="space-y-2 min-w-0">
              <p id={enrolKeyId} className="space-y-2">
                <span className="block text-xs text-slate">Cannot scan? Enter this key by hand:</span>
                <span className="block font-mono-data text-xs break-all">{stage.secret}</span>
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <input
              ref={codeInputRef}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-label="Six-digit code from your app"
              aria-describedby={`${enrolHelpId} ${enrolKeyId}`}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              placeholder="000000"
              className="border border-field rounded-lg px-3 py-2 text-sm font-mono-data w-32 focus:outline-none focus:border-black"
            />
            <button
              type="button"
              onClick={() => void confirmTotp()}
              disabled={busy || code.trim().length < 6}
              className="bg-black text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40"
            >
              Turn on
            </button>
            <button
              type="button"
              onClick={() => setStage({ kind: 'idle' })}
              className="text-xs underline underline-offset-2"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : stage.kind === 'disabling' ? (
        <div className="border border-line rounded-xl p-5 space-y-3">
          <p id={disableHelpId} className="text-sm text-slate">
            Enter a current code — or a backup code — to switch two-step verification off.
          </p>
          <div className="flex gap-2">
            <input
              ref={codeInputRef}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-label="Current code or backup code"
              aria-describedby={disableHelpId}
              autoComplete="one-time-code"
              maxLength={12}
              className="border border-field rounded-lg px-3 py-2 text-sm font-mono-data w-40 focus:outline-none focus:border-black"
            />
            <button
              type="button"
              onClick={() => void disable()}
              disabled={busy || code.trim().length < 6}
              className="border border-gray-200 rounded-lg px-4 py-2 text-sm font-medium hover:border-black disabled:opacity-40"
            >
              Turn off
            </button>
            <button
              type="button"
              onClick={() => setStage({ kind: 'idle' })}
              className="text-xs underline underline-offset-2"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="border border-line rounded-xl divide-y divide-line">
          {!enabled ? (
            <>
              <p className="px-4 py-3 text-sm text-slate leading-relaxed">
                {adminMode
                  ? 'This account can suspend and block every client, so it needs an authenticator app before the console opens. Scan the code with Google Authenticator, 1Password, Authy or similar.'
                  : "Two-step verification asks for a code as well as your sign-in. It is the single most useful thing you can switch on here — your dashboard carries your callers' names, numbers and what they said."}
              </p>
              <button
                type="button"
                onClick={() => void startTotp()}
                disabled={busy || !status.totpAvailable}
                className="w-full px-4 py-3 flex items-center justify-between gap-4 hover:bg-cream transition disabled:opacity-40 text-left"
              >
                <span>
                  <span className="block text-sm font-medium">Use an authenticator app</span>
                  <span className="block text-xs text-slate">
                    {status.totpAvailable
                      ? 'Works offline. Recommended.'
                      : 'Not available on this deployment yet.'}
                  </span>
                </span>
                <KeyRound className="h-4 w-4 shrink-0" aria-hidden="true" />
              </button>
              {!adminMode && (
              <button
                type="button"
                onClick={() => void enableEmail()}
                disabled={busy || !status.emailAvailable}
                className="w-full px-4 py-3 flex items-center justify-between gap-4 hover:bg-cream transition disabled:opacity-40 text-left"
              >
                <span>
                  <span className="block text-sm font-medium">Email me a code</span>
                  <span className="block text-xs text-slate">
                    {status.emailAvailable
                      ? 'Simpler, but only as safe as your inbox.'
                      : 'Not available on this deployment yet.'}
                  </span>
                </span>
              </button>
              )}
            </>
          ) : (
            <>
              <div className="px-4 py-3 flex items-center justify-between gap-4">
                <span>
                  <span className="block text-sm font-medium">Backup codes</span>
                  <span className="block text-xs text-slate">
                    {status.backupCodesRemaining} unused
                    {status.backupCodesRemaining <= 2 && ' — worth generating a new set'}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void regenerate()}
                  disabled={busy}
                  className="text-xs underline underline-offset-2 shrink-0"
                >
                  Generate new
                </button>
              </div>
              {!adminMode && (
                <button
                  type="button"
                  onClick={() => {
                    setCode('');
                    setStage({ kind: 'disabling' });
                  }}
                  className="w-full px-4 py-3 text-left text-sm hover:bg-cream transition"
                >
                  Turn two-step verification off
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
