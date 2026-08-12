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

  it('grounds the operator agreement in the transborder-flow section', () => {
    const operatorText = LEGAL_DOCUMENTS.operator.sections
      .flatMap((section) => section.body)
      .join(' ');
    expect(operatorText).toMatch(/section 72/i);
  });
});
