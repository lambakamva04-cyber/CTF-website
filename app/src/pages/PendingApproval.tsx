import { Clock, LogOut, ShieldAlert } from 'lucide-react';
import type { MeResponse } from '../../shared/types';
import { BrandShell } from '../components/Brand';

/**
 * Where a client lands when their organization is not active. Signing up
 * creates an account, not access — this is the screen that makes that
 * difference visible instead of showing an empty dashboard that looks broken.
 */
export function PendingApproval({
  session,
  onSignOut,
}: {
  session: MeResponse;
  onSignOut: () => void;
}) {
  const suspended = session.org.status === 'suspended';

  return (
    <BrandShell>
      <div className="space-y-6 text-center">
        <div
          className={`h-12 w-12 rounded-full flex items-center justify-center mx-auto ${
            suspended ? 'bg-red-100' : 'bg-cream-dim'
          }`}
        >
          {suspended ? (
            <ShieldAlert className="h-5 w-5 text-red-700" aria-hidden="true" />
          ) : (
            <Clock className="h-5 w-5 text-slate" aria-hidden="true" />
          )}
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">
            {suspended ? 'Account suspended' : 'Almost there'}
          </h1>
          <p className="text-sm text-slate leading-relaxed">
            {suspended ? (
              <>
                Access to <strong className="text-ink">{session.org.name}</strong> has been
                withdrawn. Your call history has been kept, not deleted. Get in touch and we will sort it out.
              </>
            ) : (
              <>
                <strong className="text-ink">{session.org.name}</strong> is registered and waiting
                for us to activate it. We usually do this within one business day, and you will be
                able to sign in and see your calls the moment it is live.
              </>
            )}
          </p>
        </div>

        <div className="border border-line rounded-xl p-4 text-left space-y-1.5 bg-white">
          <p className="text-xs text-slate">Signed in as</p>
          <p className="text-sm font-medium">{session.user.email}</p>
          <p className="text-xs text-slate">
            {session.org.name} · {suspended ? 'Suspended' : 'Pending activation'}
          </p>
        </div>

        <p className="text-xs text-slate">
          Questions? Contact us via{' '}
          <a
            href="https://www.cutthroughfaster.com"
            className="underline underline-offset-2 text-ink"
          >
            cutthroughfaster.com
          </a>
          .
        </p>

        <button
          type="button"
          onClick={onSignOut}
          className="text-xs text-slate hover:text-ink transition inline-flex items-center gap-1.5"
        >
          <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
          Sign out
        </button>
      </div>
    </BrandShell>
  );
}
