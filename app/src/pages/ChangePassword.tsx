import { useState, type FormEvent } from 'react';
import { checkPassword } from '../../shared/password';
import { api, ApiError } from '../lib/api';
import { PasswordField } from '../components/PasswordField';
import { Banner } from '../components/ui';

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
  const { acceptable } = checkPassword(newPassword);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting || mismatch || !acceptable) return;

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
      <main className="w-full max-w-sm space-y-8">
        <div className="space-y-2">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Choose a new password
          </h1>
          <p className="text-sm text-slate">
            Set your own password before you carry on. Signing in elsewhere will need the new one.
          </p>
        </div>

        {error && <Banner tone="error">{error}</Banner>}

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <PasswordField
            label="Current password"
            value={currentPassword}
            onChange={setCurrentPassword}
            autoComplete="current-password"
            showRequirements={false}
          />

          <PasswordField label="New password" value={newPassword} onChange={setNewPassword} />

          <PasswordField
            label="Confirm new password"
            value={confirmation}
            onChange={setConfirmation}
            showRequirements={false}
          />

          {mismatch && (
            <p role="alert" className="text-xs text-red-600">
              Those two passwords do not match.
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || mismatch || !acceptable || !currentPassword}
            className="w-full bg-black text-white rounded-xl py-3 font-medium text-sm hover:bg-gray-800 transition disabled:opacity-40"
          >
            {submitting ? 'Saving…' : 'Save password'}
          </button>
        </form>
      </main>
    </div>
  );
}
