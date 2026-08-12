import type { LegalDocumentId } from '../../shared/legal';
import { LEGAL_DOCUMENTS, SUB_PROCESSORS } from '../../shared/legal';
import { BrandShell } from '../components/Brand';

const ORDER: LegalDocumentId[] = ['terms', 'privacy', 'operator'];

const SHORT_TITLE: Record<LegalDocumentId, string> = {
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
  operator: 'Operator Agreement',
};

/**
 * The policies are bundled with the app rather than fetched, so they render
 * instantly and remain readable if the API is down — the one time someone is
 * most likely to go looking for the terms.
 */
export function Legal({ document, onBack }: { document: LegalDocumentId; onBack: () => void }) {
  const doc = LEGAL_DOCUMENTS[document];

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

        {/* The list of sub-processors belongs with the privacy policy, but as a
            table rather than prose: a client checking who holds their callers'
            recordings should be able to see it at a glance. */}
        {document === 'privacy' && (
          <section className="space-y-3">
            <h2 className="text-base font-semibold">Who else handles the information</h2>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full min-w-[34rem] text-left text-sm">
                <thead className="bg-ink/5 text-xs uppercase tracking-wide text-slate">
                  <tr>
                    <th className="px-3 py-2 font-medium">Company</th>
                    <th className="px-3 py-2 font-medium">What they do</th>
                    <th className="px-3 py-2 font-medium">Where</th>
                    <th className="px-3 py-2 font-medium">Caller data</th>
                  </tr>
                </thead>
                <tbody>
                  {SUB_PROCESSORS.map((processor) => (
                    <tr key={processor.name} className="border-t border-line align-top">
                      <td className="px-3 py-2 font-medium">{processor.name}</td>
                      <td className="px-3 py-2 text-slate">{processor.role}</td>
                      <td className="px-3 py-2 text-slate">{processor.location}</td>
                      <td className="px-3 py-2 text-slate">
                        {processor.handlesCallerData ? 'Yes' : 'No'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <div className="flex flex-wrap gap-4 pt-2 text-sm">
          <button type="button" onClick={onBack} className="underline underline-offset-2">
            Back
          </button>
          {ORDER.filter((id) => id !== document).map((id) => (
            <a key={id} href={`/${id}`} className="underline underline-offset-2 text-slate">
              {SHORT_TITLE[id]}
            </a>
          ))}
        </div>
      </article>
    </BrandShell>
  );
}
