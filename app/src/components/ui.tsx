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

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-gray-400">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      <span className="text-sm">{label}</span>
    </div>
  );
}
