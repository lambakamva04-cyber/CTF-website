import type { LegalDocument } from '../../shared/legal';
import { PRIVACY, TERMS } from '../../shared/legal';
import { BrandShell } from '../components/Brand';

/**
 * The policies are bundled with the app rather than fetched, so they render
 * instantly and remain readable if the API is down — the one time someone is
 * most likely to go looking for the terms.
 */
export function Legal({ document, onBack }: { document: 'terms' | 'privacy'; onBack: () => void }) {
  const doc: LegalDocument = document === 'terms' ? TERMS : PRIVACY;

  return (
    <BrandShell wide>
      <article className="space-y-8">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">{doc.title}</h1>
          <p className="text-xs text-slate font-mono-data">
            Version {doc.version} · Updated {doc.updated}
          </p>
          <p className="text-sm text-slate leading-relaxed">{doc.intro}</p>
        </header>

        {doc.sections.map((section) => (
          <section key={section.heading} className="space-y-2">
            <h2 className="text-base font-semibold">{section.heading}</h2>
            {section.body.map((paragraph, index) => (
              <p key={index} className="text-sm text-slate leading-relaxed">
                {paragraph}
              </p>
            ))}
          </section>
        ))}

        <div className="flex gap-4 pt-2 text-sm">
          <button type="button" onClick={onBack} className="underline underline-offset-2">
            Back
          </button>
          <a
            href={document === 'terms' ? '/privacy' : '/terms'}
            className="underline underline-offset-2 text-slate"
          >
            {document === 'terms' ? 'Privacy Policy' : 'Terms of Service'}
          </a>
        </div>
      </article>
    </BrandShell>
  );
}
