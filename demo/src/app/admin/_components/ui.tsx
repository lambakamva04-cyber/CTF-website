// Presentational building blocks for the admin analytics dashboard, styled
// straight from the CTF design language (see ../_theme/DESIGN.md). All server
// components — nothing here is interactive, so there is no client bundle.
//
// Colours are var(--ctf-*) so every piece flips correctly in dark mode.

import type { ReactNode } from 'react';

/** The five funnel states, each mapped to a CTF status family. */
const STATUS = {
  opened: { label: 'Opened', fam: 'neutral' },
  called: { label: 'Called', fam: 'amber' },
  replied: { label: 'Replied', fam: 'info' },
  interested: { label: 'Interested', fam: 'success' },
  optedOut: { label: 'Opted out', fam: 'danger' },
  idle: { label: 'No activity', fam: 'neutral' },
} as const;

export type StatusKey = keyof typeof STATUS;

export function StatusBadge({ status }: { status: StatusKey }) {
  const { label, fam } = STATUS[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-medium"
      style={{
        color: `var(--ctf-${fam}-fg)`,
        backgroundColor: `var(--ctf-${fam}-bg)`,
        borderColor: `var(--ctf-${fam}-border)`,
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: `var(--ctf-${fam}-fg)` }} />
      {label}
    </span>
  );
}

/** A single KPI number with a mono label and an optional muted sub-line. */
export function StatTile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-[var(--ctf-radius-lg)] border border-[var(--ctf-line)] bg-[var(--ctf-surface)] p-5">
      <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--ctf-ink-faint)]">{label}</p>
      <p className="ctf-nums mt-3 font-[var(--ctf-font-display)] text-[32px] font-bold leading-none tracking-[-0.01em] text-[var(--ctf-ink)]">
        {value}
      </p>
      {hint ? <p className="mt-2 text-[13px] text-[var(--ctf-ink-faint)]">{hint}</p> : null}
    </div>
  );
}

export type FunnelStage = { label: string; value: number; fam: 'neutral' | 'amber' | 'info' | 'success' };

/** Stacked horizontal bars, widths relative to the largest stage. */
export function FunnelBar({ stages }: { stages: FunnelStage[] }) {
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <div className="space-y-2.5">
      {stages.map((s) => (
        <div key={s.label} className="flex items-center gap-3">
          <span className="w-24 shrink-0 text-[13px] text-[var(--ctf-ink-soft)]">{s.label}</span>
          <div className="h-6 flex-1 overflow-hidden rounded-[var(--ctf-radius-sm)] bg-[var(--ctf-paper-dim)]">
            <div
              className="flex h-full min-w-[1.75rem] items-center justify-end rounded-[var(--ctf-radius-sm)] px-2"
              style={{ width: `${(s.value / max) * 100}%`, backgroundColor: `var(--ctf-${s.fam}-bg)` }}
            >
              <span className="ctf-nums text-[12px] font-semibold" style={{ color: `var(--ctf-${s.fam}-fg)` }}>
                {s.value}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The workhorse container: a hairline border, never a shadow. */
export function SectionCard({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <section className="rounded-[var(--ctf-radius-lg)] border border-[var(--ctf-line)] bg-[var(--ctf-surface)] p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-[var(--ctf-font-display)] text-[20px] font-semibold tracking-[-0.01em]">{title}</h3>
        {meta ? (
          <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--ctf-ink-faint)]">{meta}</span>
        ) : null}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** Shown in place of a table when there is nothing to show yet. */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[var(--ctf-radius-sm)] border border-dashed border-[var(--ctf-line-strong)] bg-[var(--ctf-paper-dim)]/40 px-4 py-8 text-center text-[14px] text-[var(--ctf-ink-faint)]">
      {children}
    </div>
  );
}

/** A compact, human relative time ("2h ago"), or an em dash for null. */
export function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
}
