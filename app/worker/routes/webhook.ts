import type { Env } from '../env';
import { newId, sha256Hex } from '../lib/crypto';
import type { CallRow, OrgRow } from '../lib/db';
import { json } from '../lib/http';
import {
  deriveOutcome,
  mapStatus,
  normalizeEvent,
  verifyWebhook,
  type NormalizedEvent,
} from '../lib/vapi';
import { appendTranscriptLine } from './calls';

/**
 * Vapi server webhook. Returns 200 for anything it cannot act on (unknown org,
 * uninteresting event type) so Vapi does not enter a retry loop over a message
 * that will never succeed; genuine failures throw and surface as 5xx.
 */
export async function handleVapiWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  await verifyWebhook(request, env, rawBody);

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, reason: 'invalid_json' }, { status: 400 });
  }

  const event = normalizeEvent(payload);
  if (!event || !event.vapiCallId) {
    return json({ ok: true, reason: 'ignored' });
  }

  // Idempotency: Vapi retries on non-2xx and occasionally double-delivers. A
  // retry replays the byte-identical body, so hashing it collapses duplicates
  // without ever merging two genuinely different messages.
  const eventId = event.messageId ?? (await sha256Hex(rawBody));
  const inserted = await env.DB.prepare(
    'INSERT OR IGNORE INTO webhook_events (id, received_at) VALUES (?, ?)',
  )
    .bind(eventId, Date.now())
    .run();
  if ((inserted.meta.changes ?? 0) === 0) {
    return json({ ok: true, reason: 'duplicate' });
  }

  const org = await resolveOrg(env, event);
  if (!org) {
    console.warn('webhook_org_unresolved', {
      assistantId: event.assistantId,
      phoneNumberId: event.phoneNumberId,
    });
    return json({ ok: true, reason: 'unknown_org' });
  }

  const call = await upsertCall(env, org, event);

  if (event.transcript.length > 0) {
    await persistTranscript(env, call, event);
  }

  const finished = event.type === 'end-of-call-report' || mapStatus(event.status) === 'ended';
  if (finished) {
    await finalizeCall(env, call.id, org.id, event);
  }

  return json({ ok: true });
}

async function resolveOrg(env: Env, event: NormalizedEvent): Promise<OrgRow | null> {
  if (event.assistantId) {
    const byAssistant = await env.DB.prepare(
      'SELECT * FROM organizations WHERE vapi_assistant_id = ?',
    )
      .bind(event.assistantId)
      .first<OrgRow>();
    if (byAssistant) return byAssistant;
  }

  if (event.phoneNumberId) {
    const byPhone = await env.DB.prepare(
      'SELECT * FROM organizations WHERE vapi_phone_number_id = ?',
    )
      .bind(event.phoneNumberId)
      .first<OrgRow>();
    if (byPhone) return byPhone;
  }

  // A call already in flight identifies its own org, which covers events that
  // arrive without assistant or phone-number context.
  if (event.vapiCallId) {
    const existing = await env.DB.prepare(
      `SELECT o.* FROM organizations o
         JOIN calls c ON c.org_id = o.id
        WHERE c.vapi_call_id = ?`,
    )
      .bind(event.vapiCallId)
      .first<OrgRow>();
    if (existing) return existing;
  }

  return null;
}

async function upsertCall(env: Env, org: OrgRow, event: NormalizedEvent): Promise<CallRow> {
  const now = Date.now();
  const status = mapStatus(event.status) ?? 'in-progress';

  await env.DB.prepare(
    `INSERT INTO calls (
       id, org_id, vapi_call_id, control_url, listen_url, status,
       caller_name, caller_number, started_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT (vapi_call_id) DO UPDATE SET
       control_url  = COALESCE(excluded.control_url, calls.control_url),
       listen_url   = COALESCE(excluded.listen_url, calls.listen_url),
       caller_name  = COALESCE(excluded.caller_name, calls.caller_name),
       caller_number = COALESCE(excluded.caller_number, calls.caller_number),
       -- Never walk a call backwards out of 'transferring': once staff have
       -- taken it over, only an 'ended' update may change the state.
       status = CASE
         WHEN excluded.status = 'ended' THEN 'ended'
         WHEN calls.status = 'ended' THEN 'ended'
         WHEN calls.status = 'transferring' THEN 'transferring'
         ELSE excluded.status
       END,
       updated_at = excluded.updated_at`,
  )
    .bind(
      newId('call'),
      org.id,
      event.vapiCallId,
      event.controlUrl,
      event.listenUrl,
      status,
      event.callerName,
      event.callerNumber,
      event.startedAt ?? now,
      now,
    )
    .run();

  const row = await env.DB.prepare('SELECT * FROM calls WHERE vapi_call_id = ?')
    .bind(event.vapiCallId)
    .first<CallRow>();

  if (!row) throw new Error(`call row missing after upsert: ${event.vapiCallId}`);
  return row;
}

async function persistTranscript(
  env: Env,
  call: CallRow,
  event: NormalizedEvent,
): Promise<void> {
  // Live `transcript` events append one line at a time.
  if (event.type === 'transcript') {
    for (const line of event.transcript) {
      await appendTranscriptLine(env, call, line.speaker, line.text, line.at);
    }
    return;
  }

  // The end-of-call report carries the whole conversation. Only use it to
  // backfill calls where live events never arrived, otherwise every line would
  // be duplicated at hang-up.
  const existing = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM transcript_lines
      WHERE call_id = ? AND speaker IN ('ai', 'caller')`,
  )
    .bind(call.id)
    .first<{ count: number }>();

  if ((existing?.count ?? 0) > 0) return;

  for (const line of event.transcript) {
    await appendTranscriptLine(env, call, line.speaker, line.text, line.at);
  }
}

async function finalizeCall(
  env: Env,
  callId: string,
  orgId: string,
  event: NormalizedEvent,
): Promise<void> {
  const call = await env.DB.prepare('SELECT * FROM calls WHERE id = ? AND org_id = ?')
    .bind(callId, orgId)
    .first<CallRow>();
  if (!call) return;

  const endedAt = event.endedAt ?? Date.now();
  const durationS =
    event.durationS ?? Math.max(0, Math.round((endedAt - call.started_at) / 1000));

  const { outcome, service, bookingWhen } = deriveOutcome({
    structured: event.structured,
    endedReason: event.endedReason,
    wasTakenOver: call.taken_over_by !== null,
    durationS,
  });

  const intent =
    outcome === 'booked'
      ? 'New Appointment'
      : outcome === 'escalated'
        ? 'Urgent / Escalation'
        : outcome === 'missed'
          ? 'No answer'
          : 'General Inquiry';

  await env.DB.prepare(
    `UPDATE calls
        SET status = 'ended',
            control_url = NULL,
            ended_at = COALESCE(ended_at, ?1),
            duration_s = ?2,
            outcome = ?3,
            service = COALESCE(?4, service),
            booking_when = COALESCE(?5, booking_when),
            intent = COALESCE(intent, ?6),
            summary = COALESCE(?7, summary),
            recording_url = COALESCE(?8, recording_url),
            ended_reason = COALESCE(?9, ended_reason),
            updated_at = ?10
      WHERE id = ?11 AND org_id = ?12`,
  )
    .bind(
      endedAt,
      durationS,
      outcome,
      service,
      bookingWhen,
      intent,
      event.summary,
      event.recordingUrl,
      event.endedReason,
      Date.now(),
      callId,
      orgId,
    )
    .run();
}
