import { AlertCircle, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

export function StatusPill({ active, label }: { active: boolean; label?: string }) {
  const text = label ?? (active ? 'Active' : 'Offline');
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border border-gray-200 rounded-full shrink-0">
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full bg-black ${active ? 'animate-pulse' : 'opacity-20'}`}
      />
      <span className="text-xs font-medium text-gray-600">{text}</span>
    </div>
  );
}

export function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-gray-200 rounded-2xl p-4 sm:p-5 text-center">
      <p className="font-display text-xl sm:text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-gray-400 mt-1">{label}</p>
    </div>
  );
}

/**
 * Minutes used against the plan for the month.
 *
 * The bar is scaled to whichever is larger, usage or plan, so going over does
 * not just peg a full bar — the overage keeps growing visibly past the mark
 * where the plan ran out. Monochrome like the rest of the dashboard: the
 * included minutes are solid, the overage is the lighter segment after the
 * divider.
 */
export function MinuteMeter({ used, plan }: { used: number; plan: number }) {
  const safeUsed = Math.max(0, used);
  const safePlan = Math.max(0, plan);
  const extra = Math.max(0, safeUsed - safePlan);
  // Avoid dividing by zero for a plan with no included minutes.
  const scale = Math.max(safeUsed, safePlan, 1);
  const withinPlan = Math.min(safeUsed, safePlan);

  return (
    <div>
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-gray-100"
        role="progressbar"
        aria-label="Minutes used against plan"
        aria-valuemin={0}
        aria-valuemax={safePlan}
        aria-valuenow={safeUsed}
        aria-valuetext={`${safeUsed} of ${safePlan} minutes used`}
      >
        <div className="h-full bg-black" style={{ width: `${(withinPlan / scale) * 100}%` }} />
        {extra > 0 && (
          <div
            className="h-full border-l border-white bg-gray-400"
            style={{ width: `${(extra / scale) * 100}%` }}
          />
        )}
      </div>
      <div className="mt-2 flex justify-between text-xs text-gray-400 tabular-nums">
        <span>
          {safeUsed} of {safePlan} min
        </span>
        <span>{extra > 0 ? `${extra} over` : `${safePlan - safeUsed} left`}</span>
      </div>
    </div>
  );
}

interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  ariaLabel: string;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="inline-flex items-center bg-gray-50 rounded-full p-1 text-xs">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={`px-3 py-1.5 rounded-full transition font-medium ${
            value === option.value ? 'bg-black text-white' : 'text-gray-500 hover:text-black'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Banner({
  tone = 'error',
  children,
  onRetry,
}: {
  tone?: 'error' | 'warning' | 'info';
  children: ReactNode;
  onRetry?: () => void;
}) {
  const styles = {
    error: 'border-red-200 bg-red-50 text-red-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    info: 'border-gray-200 bg-gray-50 text-gray-600',
  }[tone];

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-2.5 border rounded-xl px-4 py-3 text-sm ${styles}`}
    >
      <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
      <div className="flex-1 min-w-0">{children}</div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="text-xs font-semibold underline underline-offset-2 shrink-0"
        >
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * A spinner for waits with no shape to stand in for — the answer is one word,
 * or the destination is another page entirely. Anything that resolves into a
 * known layout uses a skeleton from Skeleton.tsx instead: a spinner in that
 * position throws the content downward when it disappears.
 *
 * Currently unused in the app; kept because the in-button case (see the sign-in
 * and signup buttons, which use Loader2 directly) is the one place it stays
 * correct.
 */
export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-8 text-gray-400">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      <span className="text-sm">{label}</span>
    </div>
  );
}
