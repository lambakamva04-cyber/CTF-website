import { describe, expect, it } from 'vitest';
import { deriveOutcome, mapStatus, normalizeEvent, toE164, verifyWebhook } from '../worker/lib/vapi';
import type { Env } from '../worker/env';
import { sha256Hex } from '../worker/lib/crypto';

const env = { VAPI_WEBHOOK_SECRET: 'shhh' } as unknown as Env;

function webhookRequest(headers: Record<string, string>): Request {
  return new Request('https://app.example.com/api/vapi/webhook', { method: 'POST', headers });
}

describe('webhook verification', () => {
  it('accepts a request carrying the configured secret', async () => {
    await expect(
      verifyWebhook(webhookRequest({ 'x-vapi-secret': 'shhh' }), env, '{}'),
    ).resolves.toBeUndefined();
  });

  it('rejects a wrong or missing secret', async () => {
    await expect(verifyWebhook(webhookRequest({ 'x-vapi-secret': 'nope' }), env, '{}')).rejects.toThrow();
    await expect(verifyWebhook(webhookRequest({}), env, '{}')).rejects.toThrow();
  });

  it('accepts the same secret as a bearer token', async () => {
    // Vapi's dashboard offers the credential as either a plain secret or a
    // bearer token; picking one must not silently reject every call.
    await expect(
      verifyWebhook(webhookRequest({ authorization: 'Bearer shhh' }), env, '{}'),
    ).resolves.toBeUndefined();

    await expect(
      verifyWebhook(webhookRequest({ authorization: 'bearer   shhh  ' }), env, '{}'),
    ).resolves.toBeUndefined();
  });

  it('rejects a bearer token that is not the secret', async () => {
    await expect(
      verifyWebhook(webhookRequest({ authorization: 'Bearer nope' }), env, '{}'),
    ).rejects.toThrow();
  });

  it('ignores an Authorization scheme it does not understand', async () => {
    await expect(
      verifyWebhook(webhookRequest({ authorization: 'Basic shhh' }), env, '{}'),
    ).rejects.toThrow();
  });

  it('still accepts x-vapi-secret when a wrong bearer is also present', async () => {
    await expect(
      verifyWebhook(
        webhookRequest({ 'x-vapi-secret': 'shhh', authorization: 'Bearer wrong' }),
        env,
        '{}',
      ),
    ).resolves.toBeUndefined();
  });

  it('fails closed when no secret is configured at all', async () => {
    await expect(
      verifyWebhook(webhookRequest({ 'x-vapi-secret': 'anything' }), {} as Env, '{}'),
    ).rejects.toThrow();
  });

  it('additionally requires a valid HMAC when one is configured', async () => {
    const hmacEnv = { VAPI_WEBHOOK_SECRET: 'shhh', VAPI_WEBHOOK_HMAC_SECRET: 'hmac' } as Env;
    const body = '{"message":{"type":"status-update"}}';

    await expect(
      verifyWebhook(webhookRequest({ 'x-vapi-secret': 'shhh' }), hmacEnv, body),
    ).rejects.toThrow();

    await expect(
      verifyWebhook(
        webhookRequest({ 'x-vapi-secret': 'shhh', 'x-vapi-signature': 'deadbeef' }),
        hmacEnv,
        body,
      ),
    ).rejects.toThrow();
  });
});

describe('event normalization', () => {
  it('pulls the control url and caller off a status-update', () => {
    const event = normalizeEvent({
      message: {
        type: 'status-update',
        status: 'in-progress',
        timestamp: 1_700_000_000_000,
        call: {
          id: 'call_abc',
          assistantId: 'asst_1',
          phoneNumberId: 'pn_1',
          customer: { number: '+27821234567', name: 'Thabo Nkosi' },
          monitor: { controlUrl: 'https://control.vapi.ai/x', listenUrl: 'wss://listen' },
        },
      },
    });

    expect(event?.vapiCallId).toBe('call_abc');
    expect(event?.assistantId).toBe('asst_1');
    expect(event?.controlUrl).toBe('https://control.vapi.ai/x');
    expect(event?.callerNumber).toBe('+27821234567');
    expect(event?.callerName).toBe('Thabo Nkosi');
    expect(mapStatus(event?.status ?? null)).toBe('in-progress');
  });

  it('keeps final transcript lines and drops partials', () => {
    const base = { type: 'transcript', call: { id: 'call_abc' }, role: 'user' };

    const final = normalizeEvent({
      message: { ...base, transcriptType: 'final', transcript: "I'd like to book a cleaning." },
    });
    expect(final?.transcript).toEqual([
      expect.objectContaining({ speaker: 'caller', text: "I'd like to book a cleaning." }),
    ]);

    const partial = normalizeEvent({
      message: { ...base, transcriptType: 'partial', transcript: "I'd like to" },
    });
    expect(partial?.transcript).toEqual([]);
  });

  it('maps assistant utterances to the AI speaker', () => {
    const event = normalizeEvent({
      message: {
        type: 'transcript',
        call: { id: 'c' },
        role: 'assistant',
        transcriptType: 'final',
        transcript: 'How can I help?',
      },
    });
    expect(event?.transcript[0]?.speaker).toBe('ai');
  });

  it('reads the whole conversation and recording out of an end-of-call report', () => {
    const event = normalizeEvent({
      message: {
        type: 'end-of-call-report',
        endedReason: 'hangup',
        call: { id: 'call_abc' },
        analysis: {
          summary: 'Booked a cleaning.',
          structuredData: { outcome: 'booked', service: 'Check-up & Cleaning', bookingWhen: 'Wed, 2:30pm' },
        },
        artifact: {
          recording: { stereoUrl: 'https://storage.vapi.ai/rec.wav' },
          messages: [
            { role: 'assistant', message: 'How can I help?' },
            { role: 'user', message: 'Book a cleaning please.' },
          ],
        },
      },
    });

    expect(event?.recordingUrl).toBe('https://storage.vapi.ai/rec.wav');
    expect(event?.summary).toBe('Booked a cleaning.');
    expect(event?.transcript).toHaveLength(2);
    expect(event?.structured).toMatchObject({ outcome: 'booked' });
  });

  it('returns null for payloads that are not server messages', () => {
    expect(normalizeEvent(null)).toBeNull();
    expect(normalizeEvent('nope')).toBeNull();
    expect(normalizeEvent({ message: {} })).toBeNull();
  });

  it('surfaces Vapi\'s message id when one is sent, and null when it is not', () => {
    const withId = normalizeEvent({
      message: { type: 'status-update', id: 'msg_1', call: { id: 'call_abc' } },
    });
    expect(withId?.messageId).toBe('msg_1');

    const withoutId = normalizeEvent({
      message: { type: 'status-update', call: { id: 'call_abc' } },
    });
    expect(withoutId?.messageId).toBeNull();
  });

  it('de-duplicates by body digest, so same-millisecond utterances both survive', async () => {
    // Regression: keying de-duplication on type+call+timestamp silently dropped
    // the second of two final transcripts stamped in the same millisecond.
    const line = (text: string) =>
      JSON.stringify({
        message: {
          type: 'transcript',
          role: 'user',
          transcriptType: 'final',
          transcript: text,
          timestamp: 1_700_000_000_000,
          call: { id: 'call_abc' },
        },
      });

    const first = line('I would like to book a cleaning.');
    const second = line('Next week if possible.');

    expect(normalizeEvent(JSON.parse(first))?.messageId).toBeNull();
    expect(await sha256Hex(first)).not.toBe(await sha256Hex(second));
    expect(await sha256Hex(first)).toBe(await sha256Hex(line('I would like to book a cleaning.')));
  });
});

describe('outcome derivation', () => {
  const base = { endedReason: 'hangup', wasTakenOver: false, durationS: 120 };

  it('trusts structured data from the assistant', () => {
    expect(
      deriveOutcome({ ...base, structured: { outcome: 'booked', service: 'Filling', bookingWhen: 'Mon, 9am' } }),
    ).toEqual({ outcome: 'booked', service: 'Filling', bookingWhen: 'Mon, 9am' });
  });

  it('infers a booking when a service and time were captured', () => {
    expect(
      deriveOutcome({ ...base, structured: { service: 'Whitening Consult', bookingWhen: 'Fri, 3pm' } }).outcome,
    ).toBe('booked');
  });

  it('marks staff-handled calls as resolved', () => {
    expect(deriveOutcome({ ...base, structured: null, wasTakenOver: true }).outcome).toBe('resolved');
  });

  it('treats unanswered and very short calls as missed', () => {
    expect(deriveOutcome({ ...base, structured: null, endedReason: 'customer-did-not-answer' }).outcome).toBe('missed');
    expect(deriveOutcome({ ...base, structured: null, durationS: 2 }).outcome).toBe('missed');
  });

  it('falls back to inquiry for an ordinary conversation', () => {
    expect(deriveOutcome({ ...base, structured: null }).outcome).toBe('inquiry');
  });
});

describe('phone normalization', () => {
  it('converts South African local numbers to E.164', () => {
    expect(toE164('082 555 0134')).toBe('+27825550134');
    expect(toE164('0825550134')).toBe('+27825550134');
    expect(toE164('27825550134')).toBe('+27825550134');
    expect(toE164('+27 82 555 0134')).toBe('+27825550134');
  });

  it('passes through other international numbers untouched', () => {
    expect(toE164('+442071234567')).toBe('+442071234567');
  });

  it('rejects input that would silently fail to ring', () => {
    expect(toE164('')).toBeNull();
    expect(toE164('   ')).toBeNull();
    expect(toE164('12345')).toBeNull();
    expect(toE164('082 555')).toBeNull();
    expect(toE164('not a number')).toBeNull();
  });
});
