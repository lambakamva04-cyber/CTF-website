import { KeyRound, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
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

/** The account holder's own security settings. Not an admin screen. */
export function SecurityPanel() {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        <h2 className="font-display text-lg font-semibold">Security</h2>
        {status && (
          <span
            className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border ${
              enabled ? 'border-black' : 'border-gray-200 text-gray-500'
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
          <p className="text-[0.65rem] tracking-widest uppercase font-semibold">
            Save these now — they are not shown again
          </p>
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
          <p className="text-sm text-slate leading-relaxed">
            Scan this with Google Authenticator, 1Password, or any authenticator app, then enter
            the six-digit code it shows.
          </p>
          <div className="flex flex-col sm:flex-row gap-5 items-start">
            <QrCode value={stage.otpauthUri} size={180} />
            <div className="space-y-2 min-w-0">
              <p className="text-xs text-gray-500">Cannot scan? Enter this key by hand:</p>
              <p className="font-mono-data text-xs break-all">{stage.secret}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              maxLength={7}
              placeholder="000000"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono-data w-32 focus:outline-none focus:border-black"
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
          <p className="text-sm text-slate">
            Enter a current code — or a backup code — to switch two-step verification off.
          </p>
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              maxLength={12}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono-data w-40 focus:outline-none focus:border-black"
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
                Two-step verification asks for a code as well as your sign-in. It is the single
                most useful thing you can switch on here — your dashboard carries your callers'
                names, numbers and what they said.
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
            </>
          )}
        </div>
      )}
    </section>
  );
}
