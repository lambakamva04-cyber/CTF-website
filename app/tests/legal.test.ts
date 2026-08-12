import { describe, expect, it } from 'vitest';
import {
  BREACH_NOTIFICATION_HOURS,
  CURRENT_VERSIONS,
  INFORMATION_OFFICER,
  LEGAL_DOCUMENTS,
  OPERATOR_VERSION,
  PRIVACY_VERSION,
  SUB_PROCESSORS,
  TERMS_VERSION,
  type LegalDocumentId,
} from '../shared/legal';

const IDS: LegalDocumentId[] = ['terms', 'privacy', 'operator'];

describe('legal documents', () => {
  it('publishes every document that consent is checked against', () => {
    // hasCurrentConsent counts documents by iterating CURRENT_VERSIONS. A key
    // here without a document would make consent impossible to satisfy and lock
    // every client out of the platform.
    expect(Object.keys(CURRENT_VERSIONS).sort()).toEqual([...IDS].sort());
    expect(Object.keys(LEGAL_DOCUMENTS).sort()).toEqual([...IDS].sort());
  });

  it('stamps each document with the version it is recorded under', () => {
    for (const id of IDS) {
      expect(LEGAL_DOCUMENTS[id].version).toBe(CURRENT_VERSIONS[id]);
    }
    expect(CURRENT_VERSIONS.terms).toBe(TERMS_VERSION);
    expect(CURRENT_VERSIONS.privacy).toBe(PRIVACY_VERSION);
    expect(CURRENT_VERSIONS.operator).toBe(OPERATOR_VERSION);
  });

  it('gives every document a title, an intro and readable sections', () => {
    for (const id of IDS) {
      const doc = LEGAL_DOCUMENTS[id];
      expect(doc.title.length).toBeGreaterThan(3);
      expect(doc.intro.length).toBeGreaterThan(20);
      expect(doc.sections.length).toBeGreaterThan(0);
      for (const section of doc.sections) {
        expect(section.heading.length).toBeGreaterThan(2);
        expect(section.body.length).toBeGreaterThan(0);
        for (const paragraph of section.body) expect(paragraph.trim()).not.toBe('');
      }
    }
  });

  it('names the voice provider rather than describing it generically', () => {
    // POPIA section 51 of the Regulator's guidance and, more practically, a
    // client's own operator agreements require the sub-operators to be
    // identifiable. "A voice provider" is not identifiable.
    const names = SUB_PROCESSORS.map((processor) => processor.name);
    expect(names.some((name) => /vapi/i.test(name))).toBe(true);
    expect(names.some((name) => /cloudflare/i.test(name))).toBe(true);
    expect(SUB_PROCESSORS.some((processor) => processor.handlesCallerData)).toBe(true);
    for (const processor of SUB_PROCESSORS) {
      expect(processor.location.trim()).not.toBe('');
      expect(processor.role.trim()).not.toBe('');
    }
  });

  it('states a breach notification window inside the 72 hours we commit to', () => {
    expect(BREACH_NOTIFICATION_HOURS).toBeGreaterThan(0);
    expect(BREACH_NOTIFICATION_HOURS).toBeLessThanOrEqual(72);
    const privacyText = LEGAL_DOCUMENTS.privacy.sections
      .flatMap((section) => section.body)
      .join(' ');
    expect(privacyText).toContain(String(BREACH_NOTIFICATION_HOURS));
  });

  it('carries a contactable address for the Information Officer', () => {
    expect(INFORMATION_OFFICER.email).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
  });

  describe('liability regime in the terms', () => {
    const sections = LEGAL_DOCUMENTS.terms.sections;
    const emphasised = sections.filter((section) => section.emphasis);
    const text = sections.flatMap((section) => section.body).join(' ');

    it('caps total liability at twelve months of fees', () => {
      expect(text).toMatch(/capped at the total amount you actually paid us/i);
      expect(text).toMatch(/twelve months/i);
      // The aggregate wording is the whole point of a cap: without it, each
      // claim gets its own ceiling and the cap stops being one.
      expect(text).toMatch(/ceiling for all of them together/i);
    });

    it('excludes consequential and indirect loss, naming lost business', () => {
      expect(text).toMatch(/not liable for indirect or consequential loss/i);
      for (const head of ['lost profit', 'lost revenue', 'lost business', 'lost bookings']) {
        expect(text.toLowerCase()).toContain(head);
      }
    });

    it('bars the client from passing caller claims on to us, and indemnifies us', () => {
      expect(text).toMatch(/cannot pass what you pay on it to us/i);
      expect(text).toMatch(/you will cover us/i);
    });

    it('carves out what South African law does not allow us to limit', () => {
      // A cap with no carve-out for gross negligence risks being struck out
      // whole under section 51 of the Consumer Protection Act, which takes the
      // protection with it. These four have to survive any edit.
      for (const carveOut of [
        /gross negligence/i,
        /wilful misconduct/i,
        /death or personal injury/i,
        /POPIA/,
      ]) {
        expect(text).toMatch(carveOut);
      }
    });

    it('marks the limitation and indemnity sections as conspicuous', () => {
      // Section 49 of the Consumer Protection Act requires these be drawn to
      // the customer's attention, which is what `emphasis` drives in the UI.
      expect(emphasised).toHaveLength(2);
      expect(emphasised.map((section) => section.heading)).toEqual([
        expect.stringMatching(/owe you/i),
        expect.stringMatching(/callers/i),
      ]);
    });

    it('keeps the section numbers referenced elsewhere pointing at the right text', () => {
      // The signup and re-consent screens name "sections 9 and 10" verbatim.
      // Renumbering the document without updating them would leave the consent
      // copy pointing at the wrong clauses.
      expect(sections[8]?.heading).toMatch(/^9\./);
      expect(sections[9]?.heading).toMatch(/^10\./);
      expect(sections[8]?.emphasis).toBe(true);
      expect(sections[9]?.emphasis).toBe(true);
    });
  });

  it('grounds the operator agreement in the transborder-flow section', () => {
    const operatorText = LEGAL_DOCUMENTS.operator.sections
      .flatMap((section) => section.body)
      .join(' ');
    expect(operatorText).toMatch(/section 72/i);
  });
});
