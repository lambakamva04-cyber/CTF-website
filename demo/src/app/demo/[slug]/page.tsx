import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import {
  DEMO_MAX_SECONDS,
  describeDuration,
  INDUSTRY_COPY,
  isValidSlug,
  spokenPracticeName,
} from '@/lib/demo';
import { bookingUrl, vapiAssistantId, vapiHopeAssistantId, vapiPublicKey } from '@/lib/env';
import { demoPageAllowed } from '@/lib/limits';
import {
  getProspectBySlug,
  getPublicLineSeconds,
  industryOf,
  toPublicProspect,
  type ProspectRow,
} from '@/lib/prospects';

import DemoPanel from './DemoPanel';

// `demo_used_at` flips mid-session, so this page can never be cached or
// prerendered — a stale render would offer a second call on a spent link.
export const dynamic = 'force-dynamic';

type PageProps = { params: Promise<{ slug: string }> };

/**
 * The Vapi assistant for this link, or null when it is not set up yet.
 *
 * - A dental link keeps the dental assistant (VAPI_ASSISTANT_ID), so every link
 *   already in an inbox plays exactly as it did.
 * - A law firm's link needs Hope (VAPI_HOPE_ASSISTANT_ID). Until she is set it
 *   is a 404, like a wrong link, so the outreach link check never passes it.
 * - The public line uses Hope once she is set, with the industry picker;
 *   before that it stays the dental sample on the dental assistant.
 */
function assistantFor(row: ProspectRow): string | null {
  const hope = vapiHopeAssistantId();
  if (row.is_public) return hope ?? (industryOf(row) === 'dental' ? vapiAssistantId() : null);
  return industryOf(row) === 'dental' ? vapiAssistantId() : hope;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  if (!isValidSlug(slug) || !(await demoPageAllowed())) return { title: 'Not found' };

  const prospect = await getProspectBySlug(slug);
  if (!prospect || !assistantFor(prospect)) return { title: 'Not found' };

  if (prospect.is_public) {
    const length = describeDuration(await getPublicLineSeconds());
    return {
      title: 'Talk to Hope, the CTF AI receptionist',
      description: `A live conversation of up to ${length} with Hope, the AI receptionist that picks up when a front desk can't.`,
      robots: { index: false, follow: false },
    };
  }

  return {
    title: `Hope, answering for ${prospect.practice_name}`,
    description: `A live conversation of up to ${describeDuration(DEMO_MAX_SECONDS)} with Hope, the AI receptionist that picks up when ${prospect.practice_name}'s front desk can't.`,
    robots: { index: false, follow: false },
  };
}

export default async function DemoPage({ params }: PageProps) {
  const { slug } = await params;

  // A malformed slug and an unknown slug end in exactly the same place. The
  // page must never confirm that a link nearly exists.
  if (!isValidSlug(slug)) notFound();

  // Someone loading page after page is walking through practice names looking
  // for links. They get the same page as a wrong link, from the edge counter
  // rather than a database lookup.
  if (!(await demoPageAllowed())) notFound();

  const row = await getProspectBySlug(slug);
  if (!row) notFound();

  const assistantId = assistantFor(row);
  if (!assistantId) notFound();

  const prospect = toPublicProspect(row);
  const copy = INDUSTRY_COPY[prospect.industry];
  // Only Hope knows every industry, so only she gets the picker.
  const industryPicker = prospect.public_line && assistantId === vapiHopeAssistantId();
  // The public line's length lives in `demo_limits`; a personal link's is fixed.
  const maxSeconds = prospect.public_line ? await getPublicLineSeconds() : DEMO_MAX_SECONDS;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-5 pb-12 pt-8 sm:px-8 sm:pt-14">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
        Cut Through Faster
      </p>

      {prospect.public_line ? (
        <header className="mt-7">
          <p className="text-sm font-medium text-signal">Our public line</p>
          <h1 className="mt-2 text-[1.875rem] font-bold leading-[1.12] sm:text-[2.375rem]">
            Talk to Hope, our AI receptionist.
          </h1>
          <p className="mt-4 text-[17px] leading-relaxed text-ink-soft">
            {industryPicker ? (
              <>Pick the kind of business you run and she answers for a sample one, so you can hear</>
            ) : (
              <>
                Here she is answering for {spokenPracticeName(prospect.practice_name)}, a sample
                practice, so you can hear
              </>
            )}{' '}
            what your {industryPicker ? 'callers' : 'patients'} would. Set up for you, she picks
            up when your team can&rsquo;t &mdash; another call,{' '}
            {industryPicker ? 'someone' : 'a patient'} at the counter, after
            hours &mdash; and takes the booking.
          </p>
        </header>
      ) : (
        <header className="mt-7">
          <p className="text-sm font-medium text-signal">Prepared for {prospect.practice_name}</p>
          <h1 className="mt-2 text-[1.875rem] font-bold leading-[1.12] sm:text-[2.375rem]">
            Hope, answering for {prospect.practice_name}.
          </h1>
          <p className="mt-4 text-[17px] leading-relaxed text-ink-soft">
            Hope is the overflow line for your front desk. She picks up when your team can&rsquo;t
            &mdash; another call, {copy.personAtCounter}, after hours &mdash; and {copy.takes}.
          </p>
        </header>
      )}

      {/* The button sits directly under the headline, on purpose: on a phone
          opened from an email it has to be reachable without a scroll. The
          detail below it is for the prospect who wants it, not a gate in front
          of the one thing this page is for. The panel also renders what Hope
          knows, because on the public line that follows the industry picked. */}
      <DemoPanel
        prospect={prospect}
        maxSeconds={maxSeconds}
        bookingUrl={bookingUrl()}
        vapiPublicKey={vapiPublicKey()}
        vapiAssistantId={assistantId}
        industryPicker={industryPicker}
      />

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
