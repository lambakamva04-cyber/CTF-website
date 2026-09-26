import type { LegalDocumentId } from '../../shared/legal';
import { CURRENT_VERSIONS, LEGAL_DOCUMENTS } from '../../shared/legal';

const ORDER: LegalDocumentId[] = ['terms', 'privacy', 'operator'];

const SUMMARY: Record<LegalDocumentId, string> = {
  terms:
    'What the service does and what each of us is responsible for. Sections 9 and 10 cap what you can recover from us and set out when you cover us instead.',
  privacy: 'What we collect about you and your callers, and why.',
  operator: 'How we handle your callers’ information on your behalf, as POPIA requires.',
};

/**
 * The three documents, each linked and stamped with the version being accepted.
 * Shared between signup and the re-consent screen so the two can never offer a
 * different set of documents than the server records.
 */
export function LegalDocumentLinks() {
  return (
    <div className="border border-line rounded-xl divide-y divide-line bg-white">
      {ORDER.map((id) => (
        <a
          key={id}
          href={`/${id}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-start justify-between gap-4 px-4 py-3 hover:bg-cream transition"
        >
          <span className="space-y-0.5">
            <span className="block text-sm font-medium">{LEGAL_DOCUMENTS[id].title}</span>
            <span className="block text-xs text-slate leading-relaxed">{SUMMARY[id]}</span>
          </span>
          <span className="text-xs text-slate font-mono-data shrink-0 pt-0.5">
            {CURRENT_VERSIONS[id]}
          </span>
        </a>
      ))}
    </div>
  );
}
