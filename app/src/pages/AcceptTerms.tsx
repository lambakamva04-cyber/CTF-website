import { useState } from 'react';
import { LegalDocumentLinks } from '../components/LegalDocumentLinks';
import { api, ApiError } from '../lib/api';
import { Banner } from '../components/ui';
import { BrandShell, PrimaryButton } from '../components/Brand';

/**
 * Shown when someone has not accepted the current policy versions — either an
 * existing login from before consent was recorded, or anyone after a revision.
 * The API refuses everything else until this is done, so the two cannot drift
 * apart.
 */
export function AcceptTerms({ onAccepted }: { onAccepted: () => void }) {
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await api.acceptTerms();
      onAccepted();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not record that. Try again.');
      setSubmitting(false);
    }
  };

  return (
    <BrandShell>
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">Before you continue</h1>
          <p className="text-sm text-slate leading-relaxed">
            We have published our terms, our privacy policy and the operator agreement that
            governs how we handle your callers’ information. Please read them and confirm you
            accept — we record which version you agreed to and when.
          </p>
        </div>

        {error && <Banner tone="error">{error}</Banner>}

        <LegalDocumentLinks />

        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[#14161A]"
          />
          <span className="text-xs text-slate leading-relaxed">
            I accept the Terms of Service, the Privacy Policy and the Operator Agreement, including
            that Cut Through Faster records how many calls and bookings my receptionist handles in
            order to bill me.
          </span>
        </label>

        <PrimaryButton
          type="button"
          onClick={() => void submit()}
          disabled={!accepted || submitting}
        >
          {submitting ? 'Saving…' : 'Accept and continue'}
        </PrimaryButton>
      </div>
    </BrandShell>
  );
}
