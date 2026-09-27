import type { Metadata } from 'next';

import { DEMO_PRIVACY } from '@/lib/privacy';

export const metadata: Metadata = {
  title: 'Privacy Policy — Hope demo',
  description: 'What the Hope demo pages collect, why, who handles it, and your rights under POPIA.',
};

export default function PrivacyPage() {
  const doc = DEMO_PRIVACY;

  return (
    <main className="mx-auto w-full max-w-xl px-5 pb-16 pt-8 sm:px-8 sm:pt-14">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
        Cut Through Faster · Hope demo
      </p>

      <header className="mt-7">
        <h1 className="text-[1.875rem] font-bold leading-[1.12] sm:text-[2.375rem]">{doc.title}</h1>
        <p className="mt-3 font-mono text-[12px] text-ink-faint">
          Version {doc.version} · Updated {doc.updated}
        </p>
        <p className="mt-5 text-[17px] leading-relaxed text-ink-soft">{doc.intro}</p>
      </header>

      <div className="mt-10 space-y-9">
        {doc.sections.map((section) => (
          <section key={section.heading} aria-labelledby={headingId(section.heading)}>
            <h2 id={headingId(section.heading)} className="text-xl font-semibold">
              {section.heading}
            </h2>
            <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-ink-soft">
              {section.body.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
          </section>
        ))}
      </div>

      <footer className="mt-12 border-t border-line pt-5 text-[13px] leading-relaxed text-ink-faint">
        <a href="https://www.cutthroughfaster.com" className="underline underline-offset-2">
          cutthroughfaster.com
        </a>
      </footer>
    </main>
  );
}

function headingId(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
