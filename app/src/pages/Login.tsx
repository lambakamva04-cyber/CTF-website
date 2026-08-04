import { Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { MeResponse } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { Banner } from '../components/ui';

export function Login({ onSignedIn }: { onSignedIn: (session: MeResponse) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
        caught instanceof ApiError
          ? caught.message
          : 'Could not sign you in. Please try again.',
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

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-gray-500">Email address</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="username"
              autoFocus
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
