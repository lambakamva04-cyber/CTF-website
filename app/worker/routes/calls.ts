import type {
  CallDetail,
  CallSummary,
  CallsResponse,
  LiveResponse,
  TakeoverResponse,
  TranscriptResponse,
} from '../../shared/types';
import type { Env } from '../env';
import type { AuthContext } from '../lib/auth';
import { writeAudit, type CallRow, type TranscriptRow } from '../lib/db';
import {
  badRequest,
  clientIp,
  conflict,
  json,
  notFound,
  readJson,
} from '../lib/http';
import { requirePermission } from '../lib/permissions';
import { endCall, toE164, transferCall } from '../lib/vapi';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_TRANSCRIPT_LINES = 500;

function toSummary(row: CallRow): CallSummary {
  return {
    id: row.id,
    status: row.status,
    callerName: row.caller_name,
    callerNumber: row.caller_number,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationS: row.duration_s,
    intent: row.intent,
    outcome: row.outcome,
    service: row.service,
    bookingWhen: row.booking_when,
    takenOverBy: row.taken_over_by,
    takenOverAt: row.taken_over_at,
  };
}

function toDetail(row: CallRow): CallDetail {
  return {
    ...toSummary(row),
    summary: row.summary,
    recordingUrl: row.recording_url,
    endedReason: row.ended_reason,
    transferTo: row.transfer_to,
    controllable: row.status !== 'ended' && row.control_url !== null,
  };
}

/**
 * Loads a call by id **and** org id. Passing org_id into the WHERE clause on
 * every read is what keeps one client from reading another's calls; a wrong id
 * comes back as a plain 404 rather than confirming the call exists.
 */
async function loadCall(env: Env, orgId: string, callId: string): Promise<CallRow> {
  const row = await env.DB.prepare('SELECT * FROM calls WHERE id = ? AND org_id = ?')
    .bind(callId, orgId)
    .first<CallRow>();
  if (!row) throw notFound('That call could not be found.');
  return row;
}

export async function appendTranscriptLine(
  env: Env,
  call: Pick<CallRow, 'id' | 'org_id'>,
  speaker: 'ai' | 'caller' | 'human' | 'system',
  text: string,
  at = Date.now(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO transcript_lines (call_id, org_id, seq, speaker, text, at)
     VALUES (?1, ?2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM transcript_lines WHERE call_id = ?1), ?3, ?4, ?5)`,
  )
    .bind(call.id, call.org_id, speaker, text, at)
    .run();
}

export async function handleListCalls(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const url = new URL(request.url);
  const filter = url.searchParams.get('filter') ?? 'all';
  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isInteger(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;

  const conditions = ['org_id = ?'];
  const bindings: unknown[] = [auth.org.id];

  if (filter === 'booked' || filter === 'escalated' || filter === 'missed') {
    conditions.push('outcome = ?');
    bindings.push(filter);
  } else if (filter !== 'all') {
    throw badRequest('Unknown filter.');
  }

  // Keyset pagination on (started_at, id) — stable even as new calls arrive.
  const cursor = url.searchParams.get('cursor');
  if (cursor) {
    const [startedAtRaw, cursorId] = cursor.split('_');
    const startedAt = Number.parseInt(startedAtRaw ?? '', 10);
    if (!Number.isInteger(startedAt) || !cursorId) throw badRequest('Invalid cursor.');
    conditions.push('(started_at < ? OR (started_at = ? AND id < ?))');
    bindings.push(startedAt, startedAt, cursorId);
  }

  const rows = await env.DB.prepare(
    `SELECT * FROM calls WHERE ${conditions.join(' AND ')}
      ORDER BY started_at DESC, id DESC LIMIT ?`,
  )
    .bind(...bindings, limit + 1)
    .all<CallRow>();

  const results = rows.results ?? [];
  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;
  const last = page[page.length - 1];

  const payload: CallsResponse = {
    calls: page.map(toSummary),
    nextCursor: hasMore && last ? `${last.started_at}_${last.id}` : null,
  };
  return json(payload);
}

export async function handleLiveCall(env: Env, auth: AuthContext): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT * FROM calls
      WHERE org_id = ? AND status != 'ended'
      ORDER BY started_at DESC LIMIT 1`,
  )
    .bind(auth.org.id)
    .first<CallRow>();

  const payload: LiveResponse = { call: row ? toDetail(row) : null, now: Date.now() };
  return json(payload);
}

export async function handleGetCall(
  env: Env,
  auth: AuthContext,
  callId: string,
): Promise<Response> {
  const row = await loadCall(env, auth.org.id, callId);
  return json(toDetail(row));
}

export async function handleTranscript(
  request: Request,
  env: Env,
  auth: AuthContext,
  callId: string,
): Promise<Response> {
  const call = await loadCall(env, auth.org.id, callId);

  const afterRaw = new URL(request.url).searchParams.get('after');
  const after = Number.parseInt(afterRaw ?? '0', 10);
  if (!Number.isInteger(after) || after < 0) throw badRequest('Invalid transcript cursor.');

  const rows = await env.DB.prepare(
    `SELECT seq, speaker, text, at FROM transcript_lines
      WHERE call_id = ? AND org_id = ? AND seq > ?
      ORDER BY seq ASC LIMIT ?`,
  )
    .bind(call.id, auth.org.id, after, MAX_TRANSCRIPT_LINES)
    .all<TranscriptRow>();

  const lines = rows.results ?? [];
  const payload: TranscriptResponse = {
    callId: call.id,
    lines,
    cursor: lines.length > 0 ? (lines[lines.length - 1] as TranscriptRow).seq : after,
    complete: call.status === 'ended',
  };
  return json(payload);
}

export async function handleTakeover(
  request: Request,
  env: Env,
  auth: AuthContext,
  callId: string,
): Promise<Response> {
  // Interrupting a live conversation is a privileged action, checked before the
  // call is even looked up.
  requirePermission(auth.user.role, 'calls:control');

  const call = await loadCall(env, auth.org.id, callId);

  if (call.status === 'ended') throw conflict('That call has already ended.');
  if (call.status === 'transferring') {
    throw conflict('This call is already being transferred to a colleague.');
  }
  if (!call.control_url) {
    throw conflict('This call can no longer be controlled. It may have just ended.');
  }

  const body = await readJson<{ number?: unknown }>(request).catch(() => ({ number: undefined }));
  const requested = typeof body.number === 'string' ? body.number : null;
  const candidate = requested ?? auth.user.phone ?? auth.org.takeover_number;

  if (!candidate) {
    throw badRequest(
      'No phone number to ring. Add a mobile number to your profile before taking over a call.',
    );
  }

  const destination = toE164(candidate);
  if (!destination) {
    throw badRequest(`"${candidate}" is not a valid phone number.`);
  }

  const handoffLine = `Let me put you through to a colleague now, please hold.`;
  await transferCall(call.control_url, destination, handoffLine);

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE calls
        SET status = 'transferring', taken_over_by = ?, taken_over_at = ?, transfer_to = ?, updated_at = ?
      WHERE id = ? AND org_id = ?`,
  )
    .bind(auth.user.id, now, destination, now, call.id, auth.org.id)
    .run();

  await appendTranscriptLine(
    env,
    call,
    'system',
    `${auth.user.name} took over — ringing ${destination}`,
    now,
  );

  await writeAudit(env.DB, {
    orgId: auth.org.id,
    userId: auth.user.id,
    action: 'call.takeover',
    target: call.id,
    detail: destination,
    ip: clientIp(request),
  });

  const updated = await loadCall(env, auth.org.id, callId);
  const payload: TakeoverResponse = { call: toDetail(updated), ringing: destination };
  return json(payload);
}

export async function handleEndCall(
  request: Request,
  env: Env,
  auth: AuthContext,
  callId: string,
): Promise<Response> {
  requirePermission(auth.user.role, 'calls:control');

  const call = await loadCall(env, auth.org.id, callId);
  if (call.status === 'ended') throw conflict('That call has already ended.');

  await endCall(env, call.vapi_call_id, call.control_url);

  const now = Date.now();
  // COALESCE keeps whichever end time landed first — ours or the webhook's — so
  // a race between this request and Vapi's status-update cannot skew duration.
  await env.DB.prepare(
    `UPDATE calls
        SET status = 'ended',
            ended_at = COALESCE(ended_at, ?1),
            duration_s = COALESCE(duration_s, CAST((COALESCE(ended_at, ?1) - started_at) / 1000 AS INTEGER)),
            outcome = COALESCE(outcome, CASE WHEN taken_over_by IS NOT NULL THEN 'resolved' ELSE 'inquiry' END),
            ended_reason = COALESCE(ended_reason, 'ended-by-staff'),
            control_url = NULL,
            updated_at = ?1
      WHERE id = ?2 AND org_id = ?3`,
  )
    .bind(now, call.id, auth.org.id)
    .run();

  await appendTranscriptLine(env, call, 'system', `Call ended by ${auth.user.name}`, now);

  await writeAudit(env.DB, {
    orgId: auth.org.id,
    userId: auth.user.id,
    action: 'call.end',
    target: call.id,
    ip: clientIp(request),
  });

  const updated = await loadCall(env, auth.org.id, callId);
  return json(toDetail(updated));
}
