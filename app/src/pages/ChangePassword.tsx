import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { Banner } from '../components/ui';

const MIN_LENGTH = 12;

/**
 * Shown when `mustChangePassword` is set — a client onboarded with a temporary
 * password cannot reach their call data until they have replaced it.
 */
export function ChangePassword({ onDone }: { onDone: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const mismatch = confirmation.length > 0 && confirmation !== newPassword;
  const tooShort = newPassword.length > 0 && newPassword.length < MIN_LENGTH;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting || mismatch || tooShort) return;

    setSubmitting(true);
    setError(null);
    try {
      await api.changePassword(currentPassword, newPassword);
      onDone();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not update your password.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-white text-black font-body flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-2">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Choose a new password
          </h1>
          <p className="text-sm text-gray-500">
            Set your own password before you carry on. Signing in elsewhere will need the new one.
          </p>
        </div>

        {error && <Banner tone="error">{error}</Banner>}

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-gray-500">Current password</span>
            <input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
              autoComplete="current-password"
              className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-black"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-gray-500">
              New password (at least {MIN_LENGTH} characters)
            </span>
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
              minLength={MIN_LENGTH}
              autoComplete="new-password"
              aria-invalid={tooShort}
              className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-black"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-gray-500">Confirm new password</span>
            <input
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              required
              autoComplete="new-password"
              aria-invalid={mismatch}
              className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-black"
            />
          </label>

          {mismatch && <p className="text-xs text-red-600">Those two passwords do not match.</p>}

          <button
            type="submit"
            disabled={submitting || mismatch || tooShort || !currentPassword || !newPassword}
            className="w-full bg-black text-white rounded-xl py-3 font-medium text-sm hover:bg-gray-800 transition disabled:opacity-40"
          >
            {submitting ? 'Saving…' : 'Save password'}
          </button>
        </form>
      </div>
    </div>
  );
}
