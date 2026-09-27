import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { isValidSlug, joinServices } from '@/lib/demo';
import { bookingUrl, vapiAssistantId, vapiPublicKey } from '@/lib/env';
import { getProspectBySlug, toPublicProspect } from '@/lib/prospects';

import DemoPanel from './DemoPanel';

// `demo_used_at` flips mid-session, so this page can never be cached or
// prerendered — a stale render would offer a second call on a spent link.
export const dynamic = 'force-dynamic';

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  if (!isValidSlug(slug)) return { title: 'Not found' };

  const prospect = await getProspectBySlug(slug);
  if (!prospect) return { title: 'Not found' };

  return {
    title: `Hope, answering for ${prospect.practice_name}`,
    description: `A live three-minute conversation with Hope, the AI receptionist that picks up when ${prospect.practice_name}'s front desk can't.`,
    robots: { index: false, follow: false },
  };
}

export default async function DemoPage({ params }: PageProps) {
  const { slug } = await params;

  // A malformed slug and an unknown slug end in exactly the same place. The
  // page must never confirm that a link nearly exists.
  if (!isValidSlug(slug)) notFound();

  const row = await getProspectBySlug(slug);
  if (!row) notFound();

  const prospect = toPublicProspect(row);
  const services = joinServices(prospect.services);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-5 pb-12 pt-8 sm:px-8 sm:pt-14">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
        Cut Through Faster
      </p>

      <header className="mt-7">
        <p className="text-sm font-medium text-signal">Prepared for {prospect.practice_name}</p>
        <h1 className="mt-2 text-[1.875rem] font-bold leading-[1.12] sm:text-[2.375rem]">
          Hope, answering for {prospect.practice_name}.
        </h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-soft">
          Hope is the overflow line for your front desk. She picks up when your team can&rsquo;t
          &mdash; another call, a patient at the counter, after hours &mdash; and takes the booking.
        </p>
      </header>

      {/* The button sits directly under the headline, on purpose: on a phone
          opened from an email it has to be reachable without a scroll. The
          detail below is for the prospect who wants it, not a gate in front
          of the one thing this page is for. */}
      <DemoPanel
        prospect={prospect}
        bookingUrl={bookingUrl()}
        vapiPublicKey={vapiPublicKey()}
        vapiAssistantId={vapiAssistantId()}
      />

      <section className="mt-8 rounded-xl border border-line bg-white/60 p-5">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
          What Hope already knows
        </h2>
        <dl className="mt-4 space-y-3 text-[15px]">
          <div className="flex gap-3">
            <dt className="w-20 shrink-0 text-ink-faint">Practice</dt>
            <dd className="font-medium">
              {prospect.practice_name}
              {prospect.suburb ? `, ${prospect.suburb}` : ''}
            </dd>
          </div>
          {services ? (
            <div className="flex gap-3">
              <dt className="w-20 shrink-0 text-ink-faint">Services</dt>
              <dd className="font-medium">{services}</dd>
            </div>
          ) : null}
          {prospect.hours ? (
            <div className="flex gap-3">
              <dt className="w-20 shrink-0 text-ink-faint">Hours</dt>
              <dd className="font-medium">{prospect.hours}</dd>
            </div>
          ) : null}
        </dl>
        <p className="mt-4 border-t border-line pt-4 text-sm leading-relaxed text-ink-soft">
          Ask her for an appointment on Thursday morning, or what time you close on a Saturday. She
          answers as though she is sitting behind your front desk.
        </p>
      </section>

      <footer className="mt-auto pt-10">
        <p className="border-t border-line pt-5 text-[13px] leading-relaxed text-ink-faint">
          Hope works alongside your receptionist, never instead of her — she catches the calls that
          would otherwise ring out, and every one of them lands in your team&rsquo;s inbox with a
          transcript.
        </p>
        <p className="mt-3 text-[13px] text-ink-faint">
          <a href="/privacy" className="underline underline-offset-2">
            Privacy policy
          </a>
        </p>
      </footer>
    </main>
  );
}
