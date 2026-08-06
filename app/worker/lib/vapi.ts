// Everything Vapi-specific lives here. If Vapi changes a payload shape or you
// move to another voice provider, this is the only file that has to change.

import type { Env } from '../env';
import { hmacSha256Hex, timingSafeEqual } from './crypto';
import { forbidden, upstreamError } from './http';

const VAPI_API_BASE = 'https://api.vapi.ai';
const CONTROL_TIMEOUT_MS = 10_000;

export type VapiSpeaker = 'ai' | 'caller' | 'system';

export interface NormalizedTranscriptLine {
  speaker: VapiSpeaker;
  text: string;
  at: number;
}

export interface NormalizedEvent {
  /**
   * Vapi's own message id when it sends one. Often absent, so the webhook
   * handler falls back to a digest of the raw body for de-duplication — never
   * to a type+call+timestamp tuple, which collapses two distinct utterances
   * spoken in the same millisecond and silently loses a transcript line.
   */
  messageId: string | null;
  type: string;
  vapiCallId: string | null;
  assistantId: string | null;
  phoneNumberId: string | null;
  status: string | null;
  endedReason: string | null;
  controlUrl: string | null;
  listenUrl: string | null;
  callerNumber: string | null;
  callerName: string | null;
  startedAt: number | null;
  endedAt: number | null;
  durationS: number | null;
  recordingUrl: string | null;
  summary: string | null;
  /** Only final transcript lines; partials are dropped to avoid write churn. */
  transcript: NormalizedTranscriptLine[];
  /** From Vapi's structuredDataPlan — see README for the schema to configure. */
  structured: Record<string, unknown> | null;
  timestamp: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toMillis(value: unknown): number | null {
  const n = num(value);
  if (n !== null) return n > 1e12 ? n : Math.round(n * 1000);
  const s = str(value);
  if (!s) return null;
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Where the shared secret may arrive. Vapi's server-URL credential can be
 * configured as a plain secret or as a bearer token depending on which option
 * is picked in its dashboard, and both put the same value on the wire — just
 * under a different header. Accepting either means the choice made there cannot
 * silently 403 every call.
 */
function presentedSecrets(request: Request): string[] {
  const candidates: string[] = [];

  const vapiSecret = request.headers.get('x-vapi-secret');
  if (vapiSecret) candidates.push(vapiSecret.trim());

  const authorization = request.headers.get('authorization');
  if (authorization) {
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (bearer?.[1]) candidates.push(bearer[1].trim());
  }

  return candidates;
}

/**
 * Verifies a webhook came from Vapi.
 *
 * The shared secret is the baseline, accepted from `x-vapi-secret` or an
 * `Authorization: Bearer` header. If VAPI_WEBHOOK_HMAC_SECRET is also set, an
 * `x-vapi-signature` HMAC over the raw body is required in addition — that is
 * strictly stronger, because a shared secret replayed from a captured request
 * still authenticates, whereas an HMAC is bound to the exact body.
 */
export async function verifyWebhook(request: Request, env: Env, rawBody: string): Promise<void> {
  const expectedSecret = env.VAPI_WEBHOOK_SECRET;
  if (!expectedSecret) {
    // Fail closed: an unconfigured webhook must never accept anonymous writes.
    throw forbidden('Webhook secret is not configured.');
  }

  const candidates = presentedSecrets(request);
  if (candidates.length === 0) throw forbidden('Missing webhook credential.');

  // Every candidate is checked, so timing does not reveal which header matched.
  const matches = await Promise.all(
    candidates.map((candidate) => timingSafeEqual(candidate, expectedSecret)),
  );
  if (!matches.some(Boolean)) throw forbidden('Invalid webhook secret.');

  const hmacSecret = env.VAPI_WEBHOOK_HMAC_SECRET;
  if (hmacSecret) {
    const signature = request.headers.get('x-vapi-signature');
    if (!signature) throw forbidden('Missing webhook signature.');
    const expected = await hmacSha256Hex(hmacSecret, rawBody);
    if (!(await timingSafeEqual(signature.replace(/^sha256=/, ''), expected))) {
      throw forbidden('Invalid webhook signature.');
    }
  }
}

/** Flattens a Vapi server message into the fields this app actually stores. */
export function normalizeEvent(payload: unknown): NormalizedEvent | null {
  const root = asRecord(payload);
  if (!root) return null;
  const message = asRecord(root.message) ?? root;

  const type = str(message.type);
  if (!type) return null;

  const call = asRecord(message.call);
  const monitor = call ? asRecord(call.monitor) : null;
  const customer = asRecord(message.customer) ?? (call ? asRecord(call.customer) : null);
  const artifact = asRecord(message.artifact) ?? (call ? asRecord(call.artifact) : null);
  const analysis = asRecord(message.analysis) ?? (call ? asRecord(call.analysis) : null);
  const recording = artifact ? asRecord(artifact.recording) : null;
  const assistant = asRecord(message.assistant) ?? (call ? asRecord(call.assistant) : null);
  const phoneNumber = asRecord(message.phoneNumber) ?? (call ? asRecord(call.phoneNumber) : null);

  const vapiCallId = call ? str(call.id) : null;
  const timestamp = toMillis(message.timestamp) ?? Date.now();

  const structured = analysis ? asRecord(analysis.structuredData) : null;

  return {
    messageId: str(message.id),
    type,
    vapiCallId,
    assistantId:
      (call ? str(call.assistantId) : null) ?? (assistant ? str(assistant.id) : null),
    phoneNumberId:
      (call ? str(call.phoneNumberId) : null) ?? (phoneNumber ? str(phoneNumber.id) : null),
    status: str(message.status) ?? (call ? str(call.status) : null),
    endedReason: str(message.endedReason) ?? (call ? str(call.endedReason) : null),
    controlUrl: monitor ? str(monitor.controlUrl) : null,
    listenUrl: monitor ? str(monitor.listenUrl) : null,
    callerNumber: customer ? str(customer.number) : null,
    callerName:
      (customer ? str(customer.name) : null) ??
      (structured ? str(structured.callerName) : null),
    startedAt: call ? toMillis(call.startedAt) : null,
    endedAt: call ? toMillis(call.endedAt) : null,
    durationS: num(message.durationSeconds) ?? (call ? num(call.durationSeconds) : null),
    recordingUrl:
      (recording ? str(recording.stereoUrl) ?? str(recording.url) : null) ??
      (artifact ? str(artifact.recordingUrl) : null),
    summary: analysis ? str(analysis.summary) : null,
    transcript: extractTranscript(message, artifact),
    structured,
    timestamp,
  };
}

function roleToSpeaker(role: string | null): VapiSpeaker | null {
  switch (role) {
    case 'assistant':
    case 'bot':
      return 'ai';
    case 'user':
    case 'customer':
      return 'caller';
    case 'system':
      return 'system';
    default:
      return null;
  }
}

function extractTranscript(
  message: Record<string, unknown>,
  artifact: Record<string, unknown> | null,
): NormalizedTranscriptLine[] {
  const at = toMillis(message.timestamp) ?? Date.now();

  // Live `transcript` events: one utterance at a time. Partials are skipped —
  // they are revised in place and would otherwise flood the transcript.
  if (str(message.type) === 'transcript') {
    if (str(message.transcriptType) !== 'final') return [];
    const speaker = roleToSpeaker(str(message.role));
    const text = str(message.transcript);
    if (!speaker || !text) return [];
    return [{ speaker, text, at }];
  }

  // End-of-call report: the full message list, used to backfill anything the
  // live events missed (a dropped webhook, a call that started before signup).
  const messages = artifact ? artifact.messages : null;
  if (!Array.isArray(messages)) return [];

  const lines: NormalizedTranscriptLine[] = [];
  for (const entry of messages) {
    const record = asRecord(entry);
    if (!record) continue;
    const speaker = roleToSpeaker(str(record.role));
    const text = str(record.message) ?? str(record.content);
    if (!speaker || !text) continue;
    lines.push({ speaker, text, at: toMillis(record.time) ?? at });
  }
  return lines;
}

interface ControlMessage {
  type: 'say' | 'add-message' | 'control' | 'transfer' | 'end-call';
  [key: string]: unknown;
}

async function postControl(controlUrl: string, message: ControlMessage): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONTROL_TIMEOUT_MS);
  try {
    const response = await fetch(controlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw upstreamError(
        `Vapi rejected the ${message.type} command (${response.status}). ${detail.slice(0, 200)}`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw upstreamError('Vapi did not respond in time.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Warm transfer: Vapi rings `destination` and bridges the caller to it, after
 * speaking `content` so the caller is not dropped into silence.
 */
export async function transferCall(
  controlUrl: string,
  destination: string,
  content: string,
): Promise<void> {
  await postControl(controlUrl, {
    type: 'transfer',
    destination: { type: 'number', number: destination },
    content,
  });
}

/**
 * Hangs up. Prefers the live control endpoint; falls back to the REST API,
 * which still works if the control URL has already been torn down.
 */
export async function endCall(
  env: Env,
  vapiCallId: string,
  controlUrl: string | null,
): Promise<void> {
  if (controlUrl) {
    try {
      await postControl(controlUrl, { type: 'end-call' });
      return;
    } catch (error) {
      console.warn('control_url_end_failed', error);
    }
  }

  if (!env.VAPI_PRIVATE_KEY) {
    throw upstreamError('Unable to end the call: no Vapi API key is configured.');
  }

  const response = await fetch(`${VAPI_API_BASE}/call/${encodeURIComponent(vapiCallId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${env.VAPI_PRIVATE_KEY}` },
  });

  // 404 means Vapi has already torn the call down — the desired end state.
  if (!response.ok && response.status !== 404) {
    throw upstreamError(`Vapi could not end the call (${response.status}).`);
  }
}

/** Speaks a line to the caller in the assistant's voice. */
export async function sayToCaller(controlUrl: string, content: string): Promise<void> {
  await postControl(controlUrl, { type: 'say', content, endCallAfterSpoken: false });
}

/**
 * Normalizes a South African number to E.164. Vapi rejects anything else, and
 * a silently malformed number would mean a takeover that never rings.
 */
export function toE164(raw: string, defaultDialCode = '27'): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (hasPlus) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  // 0821234567 -> +27821234567
  if (digits.startsWith('0')) {
    const national = digits.slice(1);
    return national.length === 9 ? `+${defaultDialCode}${national}` : null;
  }
  if (digits.startsWith(defaultDialCode) && digits.length === defaultDialCode.length + 9) {
    return `+${digits}`;
  }
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

/** Maps a Vapi call status onto the four states the dashboard renders. */
export function mapStatus(status: string | null): 'ringing' | 'in-progress' | 'transferring' | 'ended' | null {
  switch (status) {
    case 'queued':
    case 'ringing':
      return 'ringing';
    case 'in-progress':
      return 'in-progress';
    case 'forwarding':
      return 'transferring';
    case 'ended':
      return 'ended';
    default:
      return null;
  }
}

/**
 * Decides what the call actually achieved. Vapi's structured data is trusted
 * first; the fallbacks exist so a client who has not configured an analysis
 * plan still gets a sensible history rather than blank rows.
 */
export function deriveOutcome(input: {
  structured: Record<string, unknown> | null;
  endedReason: string | null;
  wasTakenOver: boolean;
  durationS: number | null;
}): { outcome: 'booked' | 'inquiry' | 'escalated' | 'missed' | 'resolved'; service: string | null; bookingWhen: string | null } {
  const structured = input.structured ?? {};
  const declared = str(structured.outcome);
  const service = str(structured.service);
  const bookingWhen = str(structured.bookingWhen) ?? str(structured.bookingTime);

  if (declared === 'booked' || (service && bookingWhen)) {
    return { outcome: 'booked', service, bookingWhen };
  }
  if (input.wasTakenOver) return { outcome: 'resolved', service, bookingWhen };

  const reason = input.endedReason ?? '';
  if (/no-answer|customer-did-not-answer|voicemail|busy/i.test(reason)) {
    return { outcome: 'missed', service: null, bookingWhen: null };
  }
  if (/transfer|forwarded/i.test(reason)) {
    return { outcome: 'escalated', service, bookingWhen };
  }
  if (declared === 'escalated' || declared === 'missed' || declared === 'inquiry') {
    return { outcome: declared, service, bookingWhen };
  }
  // A call too short to have been a conversation was effectively missed.
  if (input.durationS !== null && input.durationS < 5) {
    return { outcome: 'missed', service: null, bookingWhen: null };
  }
  return { outcome: 'inquiry', service, bookingWhen };
}
