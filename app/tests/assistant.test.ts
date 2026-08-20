import { describe, expect, it } from 'vitest';
import { HOPE, HOPE_VERSION } from '../assistants/hope';
import { deriveOutcome } from '../worker/lib/vapi';

const systemPrompt = HOPE.model.messages[0]?.content ?? '';
const properties = HOPE.analysisPlan.structuredDataPlan.schema.properties;

describe('what Hope reports and what the dashboard reads', () => {
  it('emits exactly the fields deriveOutcome consumes', () => {
    // Renaming one of these silently turns every call into "Inquiry" on the
    // dashboard — the kind of break nobody notices for a week, because nothing
    // errors, the numbers just quietly go wrong.
    expect(Object.keys(properties).sort()).toEqual(
      ['bookingWhen', 'callerName', 'outcome', 'service'].sort(),
    );
  });

  it('offers only outcomes the dashboard knows how to show', () => {
    const declared = properties.outcome?.enum ?? [];
    expect(declared).toEqual(['booked', 'inquiry', 'escalated', 'missed']);

    // 'resolved' is deliberately absent: it means a human took the call over,
    // which the Worker knows from the takeover it performed and the assistant
    // cannot know at all.
    expect(declared).not.toContain('resolved');
  });

  it('produces a booked call the dashboard reads as booked', () => {
    const result = deriveOutcome({
      structured: {
        outcome: 'booked',
        service: 'AI receptionist demo',
        bookingWhen: 'Tuesday 19 August, 10am',
        callerName: 'Naledi',
      },
      wasTakenOver: false,
      endedReason: 'customer-ended-call',
      durationS: 180,
    });
    expect(result.outcome).toBe('booked');
    expect(result.service).toBe('AI receptionist demo');
    expect(result.bookingWhen).toBe('Tuesday 19 August, 10am');
  });

  it('round-trips every outcome Hope can declare', () => {
    for (const outcome of properties.outcome?.enum ?? []) {
      const result = deriveOutcome({
        structured: { outcome },
        wasTakenOver: false,
        endedReason: 'customer-ended-call',
        durationS: 120,
      });
      expect(result.outcome).toBe(outcome);
    }
  });
});

describe('the things Hope must always do', () => {
  it('discloses that she is an AI and that the call is recorded, in the greeting', () => {
    // Not a stylistic preference. POPIA requires the caller be told, and CTF's
    // own operator agreement requires it of every client — so the assistant CTF
    // demonstrates with cannot be the one that skips it.
    const greeting = HOPE.firstMessage.toLowerCase();
    expect(greeting).toContain('ai');
    expect(greeting).toContain('recorded');
  });

  it('is instructed not to skip the disclosure under pressure', () => {
    expect(systemPrompt).toMatch(/not optional/i);
    expect(systemPrompt).toMatch(/recorded/i);
  });

  it('is told what to do when a caller refuses to be recorded', () => {
    expect(systemPrompt).toMatch(/objects to being recorded/i);
  });

  it('is forbidden from quoting a price', () => {
    // Getting a price wrong on a live call costs the sale and is hard to walk
    // back. Pricing depends on call volume, which Hope cannot know.
    expect(systemPrompt).toMatch(/do not quote a price/i);
  });

  it('is told to hand over immediately when asked for a person', () => {
    expect(systemPrompt).toMatch(/asks to speak to a human/i);
  });
});

describe('speaking rather than writing', () => {
  it('bans the formatting that gets read aloud as noise', () => {
    for (const banned of ['bullet points', 'markdown', 'emoji']) {
      expect(systemPrompt.toLowerCase()).toContain(banned);
    }
  });

  it('contains no markdown itself', () => {
    // A prompt written in markdown teaches the model to answer in markdown,
    // which the voice then reads out as "asterisk asterisk".
    expect(systemPrompt).not.toMatch(/^\s*[-*]\s+\*\*/m);
    expect(systemPrompt).not.toMatch(/^#{1,6}\s/m);
  });
});

describe('call handling settings', () => {
  it('stops speaking almost as soon as the caller does', () => {
    // An assistant that talks over you reads as rude much faster than one that
    // pauses a beat too long.
    expect(HOPE.stopSpeakingPlan?.numWords).toBeLessThanOrEqual(2);
  });

  it('bounds the call length', () => {
    // A phone left face-down on a desk should not run up an open-ended bill.
    expect(HOPE.maxDurationSeconds).toBeGreaterThan(0);
    expect(HOPE.maxDurationSeconds).toBeLessThanOrEqual(900);
  });

  it('waits long enough for somebody to check a diary', () => {
    expect(HOPE.silenceTimeoutSeconds).toBeGreaterThanOrEqual(15);
  });

  it('subscribes to exactly the three events the dashboard is built around', () => {
    expect(HOPE.serverMessages.sort()).toEqual(
      ['end-of-call-report', 'status-update', 'transcript'].sort(),
    );
  });

  it('transcribes as British rather than American English', () => {
    // South African English is not a Deepgram locale. en-GB handles SA vowels
    // markedly better than en-US, which mishears "eight" as "late".
    expect(HOPE.transcriber?.language).toBe('en-GB');
  });

  it('carries a version, so a call record stays explicable later', () => {
    expect(HOPE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
