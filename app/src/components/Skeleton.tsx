import type { ReactNode } from 'react';

/**
 * Loading placeholders shaped like the content they stand in for.
 *
 * The rule every skeleton here follows: it occupies the same space as the real
 * thing. A placeholder that is a different height causes the page to jump when
 * the data lands, which is worse than a spinner — the reader loses their place
 * at the exact moment they start reading.
 *
 * Accessibility is handled once, by `SkeletonRegion`: the blocks themselves are
 * `aria-hidden`, and the region announces what is loading. Screen reader users
 * get one sentence instead of a description of twelve grey rectangles.
 */

/**
 * A single placeholder block. `className` carries its size, and may carry its
 * own rounding.
 *
 * The default `rounded-md` is applied only when the caller has not asked for
 * one. Emitting both leaves the winner to stylesheet order rather than to the
 * caller — which is how the first version of this drew every avatar and pill as
 * a rounded rectangle.
 */
export function Skeleton({
  className = '',
  delay,
}: {
  className?: string;
  delay?: 1 | 2 | 3;
}) {
  const rounding = /(^|\s)rounded(-|\s|$)/.test(className) ? '' : 'rounded-md';
  return (
    <span
      aria-hidden="true"
      className={`skeleton block ${rounding} ${delay ? `skeleton-delay-${delay}` : ''} ${className}`}
    />
  );
}

/**
 * Wraps a group of skeletons. `aria-busy` tells assistive technology the region
 * is in flux, and the visually hidden label says what it is waiting for, so the
 * announcement is "Loading your recent calls" rather than silence.
 */
export function SkeletonRegion({
  label,
  className = '',
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** A run of text lines. The last is short, the way a paragraph actually ends. */
export function SkeletonText({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <span className={`block space-y-2 ${className}`}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={`h-3 ${index === lines - 1 ? 'w-2/5' : 'w-full'}`}
          delay={((index % 3) + 1) as 1 | 2 | 3}
        />
      ))}
    </span>
  );
}

/** One of the three figures under Performance. */
export function StatCardSkeleton({ delay }: { delay?: 1 | 2 | 3 }) {
  return (
    <div className="border border-gray-200 rounded-2xl p-4 sm:p-5 flex flex-col items-center gap-2">
      <Skeleton className="h-7 w-12" delay={delay} />
      <Skeleton className="h-2.5 w-16" delay={delay} />
    </div>
  );
}

export function StatGridSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-3">
      <StatCardSkeleton delay={1} />
      <StatCardSkeleton delay={2} />
      <StatCardSkeleton delay={3} />
    </div>
  );
}

/**
 * One row in the call history. Matches CallRow's collapsed height: an avatar
 * dot, a name, a line of detail, and the outcome pill on the right.
 */
export function CallRowSkeleton({ delay }: { delay?: 1 | 2 | 3 }) {
  return (
    <div className="flex items-center gap-3 py-4">
      <Skeleton className="h-8 w-8 rounded-full shrink-0" delay={delay} />
      <span className="flex-1 min-w-0 space-y-2">
        <Skeleton className="h-3.5 w-2/5" delay={delay} />
        <Skeleton className="h-2.5 w-3/5" delay={delay} />
      </span>
      <Skeleton className="h-5 w-16 rounded-full shrink-0" delay={delay} />
    </div>
  );
}

export function CallListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <SkeletonRegion
      label="Loading your recent calls"
      className="divide-y divide-gray-100 border-t border-b border-gray-100"
    >
      {Array.from({ length: rows }, (_, index) => (
        <CallRowSkeleton key={index} delay={((index % 3) + 1) as 1 | 2 | 3} />
      ))}
    </SkeletonRegion>
  );
}

/**
 * The live call card before the first poll returns. Deliberately the shape of
 * the *idle* state rather than an in-progress call — most of the time there is
 * no call, and a skeleton shaped like a live transcript would promise one.
 */
export function LiveCallSkeleton() {
  return (
    <SkeletonRegion
      label="Checking for a live call"
      className="border border-gray-200 rounded-2xl p-6 sm:p-8 space-y-4"
    >
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-6 w-20 rounded-full" delay={1} />
      </div>
      <Skeleton className="h-6 w-1/2" delay={1} />
      <SkeletonText lines={2} />
    </SkeletonRegion>
  );
}

/** A row in the team or client tables: a name, a detail line, an action. */
export function TableRowSkeleton({ delay }: { delay?: 1 | 2 | 3 }) {
  return (
    <div className="flex items-center gap-3 py-3.5">
      <span className="flex-1 min-w-0 space-y-2">
        <Skeleton className="h-3.5 w-1/3" delay={delay} />
        <Skeleton className="h-2.5 w-1/2" delay={delay} />
      </span>
      <Skeleton className="h-5 w-14 rounded-full shrink-0" delay={delay} />
    </div>
  );
}

/**
 * `className` exists so a caller can match the container the real table uses.
 * The team list has top and bottom rules; the platform table does not. A
 * skeleton that draws different edges than its replacement is a visible flicker
 * at the moment the data lands.
 */
export function TableSkeleton({
  label,
  rows = 3,
  className = '',
}: {
  label: string;
  rows?: number;
  className?: string;
}) {
  return (
    <SkeletonRegion label={label} className={`divide-y divide-gray-100 ${className}`}>
      {Array.from({ length: rows }, (_, index) => (
        <TableRowSkeleton key={index} delay={((index % 3) + 1) as 1 | 2 | 3} />
      ))}
    </SkeletonRegion>
  );
}

/**
 * The whole dashboard, before the session has come back and there is nothing
 * yet to fill any of it. Every heading a client already knows is drawn as real
 * text — only the values are placeholders. Showing "Performance" and "Recent
 * Activity" while the numbers load tells them the page is theirs and arriving,
 * where a page of uniform grey tells them nothing.
 */
export function DashboardSkeleton() {
  return (
    <div className="min-h-screen bg-white text-black">
      <div className="font-body max-w-2xl mx-auto px-6 py-10 sm:py-14 space-y-10">
        <SkeletonRegion label="Loading your dashboard" className="space-y-3">
          <Skeleton className="h-3 w-48" />
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-8 w-1/2" delay={1} />
            <Skeleton className="h-8 w-24 rounded-full shrink-0" delay={1} />
          </div>
          <Skeleton className="h-3 w-40" delay={2} />
        </SkeletonRegion>

        <LiveCallSkeleton />

        <section className="space-y-5">
          <h2 className="font-display text-lg font-semibold">Performance</h2>
          <Skeleton className="h-8 w-56 rounded-full" />
          <StatGridSkeleton />
        </section>

        <section className="space-y-5">
          <h2 className="font-display text-lg font-semibold">Recent Activity</h2>
          <div className="flex gap-2">
            <Skeleton className="h-7 w-14 rounded-full" />
            <Skeleton className="h-7 w-20 rounded-full" delay={1} />
            <Skeleton className="h-7 w-20 rounded-full" delay={2} />
          </div>
          <CallListSkeleton />
        </section>
      </div>
    </div>
  );
}
