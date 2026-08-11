import type { ReactNode } from 'react';
import { LogoLockup } from './Logo';

/**
 * The shell every signed-out screen sits in — sign in, sign up, the policies,
 * and the waiting-for-approval page. Matching the marketing site's dark header
 * over a cream page is what makes the dashboard read as the same product.
 */
export function BrandShell({
  children,
  wide = false,
}: {
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="min-h-screen bg-cream text-ink font-body flex flex-col">
      <header className="bg-ink">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <a href="/" className="text-cream">
            <LogoLockup markSize={26} />
          </a>
          <a
            href="https://www.cutthroughfaster.com"
            className="text-xs text-cream/70 hover:text-cream transition"
          >
            cutthroughfaster.com
          </a>
        </div>
      </header>

      <main
        className={`flex-1 w-full mx-auto px-6 py-12 sm:py-16 ${wide ? 'max-w-3xl' : 'max-w-md'}`}
      >
        {children}
      </main>

      <footer className="border-t border-line">
        <div className="max-w-5xl mx-auto px-6 py-6 flex flex-wrap items-center justify-between gap-3 text-xs text-slate">
          <span>© {new Date().getFullYear()} Cut Through Faster</span>
          <span className="flex gap-4">
            <a href="/terms" className="hover:text-ink transition">
              Terms
            </a>
            <a href="/privacy" className="hover:text-ink transition">
              Privacy
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}

export function PrimaryButton({
  children,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`w-full bg-ink text-cream rounded-lg py-3 font-medium text-sm hover:bg-ink-soft transition flex items-center justify-center gap-2 disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

export function TextField({
  label,
  hint,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-slate">{label}</span>
      <input
        {...props}
        className="w-full border border-line rounded-lg px-4 py-2.5 text-sm bg-white focus:outline-none focus:border-ink transition"
      />
      {hint && <span className="block text-xs text-slate">{hint}</span>}
    </label>
  );
}
