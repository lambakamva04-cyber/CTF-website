/**
 * Hope returns the website's callback requests.
 *
 * Every five minutes, inside South African calling hours, this picks up new
 * rows in `leads` and has Hope phone them through Vapi: she says she is an AI
 * and that the call is recorded, finds out what they need, explains what CTF
 * does, and sets up a proper call with Kamva. When the call ends, Kamva is
 * emailed her notes and the transcript. Nobody is left waiting on a person
 * who happens to be busy.
 *
 * A lead moves through `callback_status` (migration 0012):
 *
 *   pending → calling → completed    Hope spoke to them; Kamva is emailed her notes
 *                     → pending      no answer the first time; tried again an hour later
 *                     → no_answer    no answer twice; Kamva is emailed to call them
 *                     → failed       the call did not go through; Kamva is emailed
 *           → skipped                not called; Kamva is emailed why, when there is something to do
 *
 * Every change is made only from the status the row was read in, so two runs
 * that overlap cannot call the same person twice.
 *
 * Nothing here runs until the Vapi secrets are set: without them the Worker is
 * the daily heartbeat it always was.
 */

import { callbackOverrides, clean } from './callbackAssistant';
import { isCallingTime, sastLabel } from './sast';

export type CallbackEnv = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  VAPI_PRIVATE_KEY?: string;
  VAPI_PHONE_NUMBER_ID?: string;
  VAPI_ASSISTANT_ID?: string;
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
  LEAD_NOTIFY_TO?: string;
};

/** Calls started in one run. A run every five minutes makes this plenty. */
const CALLS_PER_RUN = 3;

/**
 * People Hope calls in any 24 hours. A ceiling on what a flood of fake form
 * entries could cost: with the one retry, at most twice this many calls.
 */
const DAILY_PEOPLE_CAP = 20;

/**
 * How old a request can be and still get a call. Long enough to carry one
 * over Easter (Thursday evening to Tuesday morning), short enough that nobody
 * is phoned about something they asked for last week.
 */
const MAX_LEAD_AGE_DAYS = 5;

const MAX_ATTEMPTS = 2;
const RETRY_AFTER_MINUTES = 60;

/** When Vapi itself is down, the lead goes back in the queue for this long. */
const VAPI_DOWN_RETRY_MINUTES = 15;

/** Somebody Hope has already spoken to this week is not called again. */
const SPOKE_RECENTLY_DAYS = 7;

/** A call still not ended after this long is written off, and Kamva told. */
const STUCK_AFTER_MINUTES = 30;

/** Vapi writes the summary just after the call ends; this is how long to wait for it. */
const SUMMARY_WAIT_MINUTES = 3;

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_TRANSCRIPT_CHARS = 12_000;

const VAPI_API = 'https://api.vapi.ai';
const EMAIL_API = 'https://api.resend.com/emails';

type LeadRow = {
  id: string;
  name: string;
  business_type: string | null;
  phone: string | null;
  message: string | null;
  created_at: string;
  contacted_at: string | null;
  callback_status: string | null;
  callback_attempts: number;
  callback_number: string | null;
  callback_call_id: string | null;
  callback_attempted_at: string | null;
};

const LEAD_COLUMNS = [
  'id', 'name', 'business_type', 'phone', 'message', 'created_at', 'contacted_at',
  'callback_status', 'callback_attempts', 'callback_number', 'callback_call_id',
  'callback_attempted_at',
].join(',');

type VapiCall = {
  id: string;
  status?: string;
  endedReason?: string;
  startedAt?: string;
  endedAt?: string;
  analysis?: { summary?: string };
  artifact?: {
    transcript?: string;
    recordingUrl?: string;
    messages?: { role?: string; message?: string }[];
  };
};

class VapiError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`Vapi answered ${status}: ${detail}`);
  }
}

function minutesAgo(iso: string | null, now: Date): number {
  return iso ? (now.getTime() - Date.parse(iso)) / 60_000 : Number.POSITIVE_INFINITY;
}

function isoIn(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isConfigured(env: CallbackEnv): boolean {
  return Boolean(env.VAPI_PRIVATE_KEY && env.VAPI_PHONE_NUMBER_ID && env.VAPI_ASSISTANT_ID);
}

/**
 * The number to dial, in the form Vapi needs (+27 and nine digits), or null
 * when it is not a South African number. Hope only calls South Africa: an
 * international call is expensive, and nobody abroad is who the form is for.
 */
export function southAfricanNumber(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  let national: string;
  if (raw.trim().startsWith('+') || digits.startsWith('00')) {
    const international = raw.trim().startsWith('+') ? digits : digits.slice(2);
    if (!international.startsWith('27')) return null;
    national = international.slice(2);
  } else if (digits.startsWith('27') && digits.length >= 11) {
    national = digits.slice(2);
  } else {
    national = digits;
  }
  // "+27 (0)82 ..." and "082 ..." both carry the trunk 0, which is not dialled
  // after +27.
  if (national.length === 10 && national.startsWith('0')) national = national.slice(1);
  return /^[1-8]\d{8}$/.test(national) ? `+27${national}` : null;
}

/**
 * How a finished call went. A call that connected but in which nobody said
 * anything — a phone answered in a pocket, a voicemail that slipped past
 * detection — counts as no answer, so it is tried again.
 */
export function outcomeOf(call: VapiCall): 'completed' | 'no_answer' | 'failed' {
  const reason = call.endedReason ?? '';
  if (/^(customer-did-not-answer|customer-busy|voicemail)$|no-answer|temporarily-unavailable/.test(reason)) {
    return 'no_answer';
  }
  if (/error|fault|failed|not-found|not-valid|misdialed|rejected|disconnected|closed-websocket|worker-shutdown|canceled|deleted/.test(reason)) {
    return 'failed';
  }
  const messages = call.artifact?.messages;
  const customerSpoke = messages
    ? messages.some((m) => m.role === 'user' && (m.message ?? '').trim() !== '')
    : /^user:/im.test(call.artifact?.transcript ?? '');
  return customerSpoke ? 'completed' : 'no_answer';
}

// --- Supabase ------------------------------------------------------------

async function db<T>(
  env: CallbackEnv,
  path: string,
  init: { method?: string; body?: unknown; prefer?: string } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.prefer ? { Prefer: init.prefer } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`supabase ${method} ${path.split('?')[0]} returned ${response.status}: ${text.slice(0, 200)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * Changes a lead, but only while it still has the status it was read with.
 * Returns false when it had moved on, which means another run got there first.
 */
async function updateLead(
  env: CallbackEnv,
  lead: LeadRow,
  fields: Record<string, unknown>,
): Promise<boolean> {
  const status = lead.callback_status === null ? 'is.null' : `eq.${lead.callback_status}`;
  const rows = await db<unknown[]>(
    env,
    `leads?id=eq.${encodeURIComponent(lead.id)}&callback_status=${status}`,
    { method: 'PATCH', body: fields, prefer: 'return=representation' },
  );
  return rows.length > 0;
}

// --- Vapi and email ------------------------------------------------------

async function vapi<T>(env: CallbackEnv, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${VAPI_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.VAPI_PRIVATE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new VapiError(response.status, text.slice(0, 300));
  return JSON.parse(text) as T;
}

/** One line, no control characters: it becomes an email header. */
function headerSafe(text: string, max: number): string {
  return text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

/**
 * Emails Kamva. Plain text, because most of it was typed by a stranger or
 * said on a call. A failure is logged and does not stop the run: the lead's
 * status is already saved, and the request itself was emailed when it came in.
 */
async function tellKamva(env: CallbackEnv, subject: string, lines: string[]): Promise<void> {
  if (!env.EMAIL_API_KEY) {
    console.warn('callbacks: EMAIL_API_KEY is not set, so nobody was emailed');
    return;
  }
  try {
    const response = await fetch(EMAIL_API, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.EMAIL_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM?.trim() || 'CTF website <website@mail.cutthroughfaster.com>',
        to: [env.LEAD_NOTIFY_TO?.trim() || 'hello@cutthroughfaster.com'],
        subject: headerSafe(subject, 140),
        text: lines.join('\n'),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(`callbacks: email failed, ${response.status}: ${detail.slice(0, 200)}`);
    }
  } catch (error) {
    console.error(`callbacks: email failed, ${message(error)}`);
  }
}

function leadDetails(lead: LeadRow): string[] {
  return [
    `Name:      ${lead.name}`,
    `Business:  ${lead.business_type ?? 'not given'}`,
    `Phone:     ${lead.phone ?? 'not given'}`,
    `Message:   ${lead.message ?? '(none)'}`,
    `Asked:     ${sastLabel(new Date(lead.created_at))} (South African time)`,
  ];
}

const SUPABASE_NOTE =
  'The request is in Supabase → Table Editor → leads; set contacted_at once you have called them.';

// --- Following up calls in progress --------------------------------------

async function followUp(env: CallbackEnv, lead: LeadRow, now: Date, notes: string[]): Promise<void> {
  const age = minutesAgo(lead.callback_attempted_at, now);
  const who = clean(lead.name, 80) || 'someone';

  const giveUp = async (reason: string) => {
    if (!(await updateLead(env, lead, { callback_status: 'failed', callback_ended_reason: reason }))) return;
    notes.push(`lead ${lead.id}: failed (${reason})`);
    await tellKamva(env, `Hope's call to ${who} may not have gone through — please call them`, [
      `Hope tried to return ${who}'s callback request, but something went wrong: ${reason}.`,
      '',
      'She may or may not have spoken to them. Please call them yourself.',
      '',
      ...leadDetails(lead),
      lead.callback_call_id ? `Vapi call:  ${lead.callback_call_id}` : '',
      '',
      SUPABASE_NOTE,
    ]);
  };

  if (!lead.callback_call_id) {
    // Claimed, but the call's id was never saved. Give an interrupted run a
    // few minutes to finish before calling it lost.
    if (age > 10) await giveUp('the call was started but never recorded');
    return;
  }

  let call: VapiCall;
  try {
    call = await vapi<VapiCall>(env, 'GET', `/call/${encodeURIComponent(lead.callback_call_id)}`);
  } catch (error) {
    if ((error instanceof VapiError && error.status === 404) || age > STUCK_AFTER_MINUTES) {
      await giveUp(`Vapi could not report on the call (${message(error)})`);
    }
    return;
  }

  if (call.status !== 'ended') {
    if (age > STUCK_AFTER_MINUTES) await giveUp(`the call was still "${call.status ?? 'unknown'}" after ${STUCK_AFTER_MINUTES} minutes`);
    return;
  }

  const outcome = outcomeOf(call);
  const reason = call.endedReason ?? 'unknown';
  const summary = call.analysis?.summary?.trim() || null;

  if (outcome === 'completed' && !summary && minutesAgo(call.endedAt ?? null, now) < SUMMARY_WAIT_MINUTES) {
    return; // the summary is still being written
  }

  if (outcome === 'no_answer' && lead.callback_attempts < MAX_ATTEMPTS) {
    const requeued = await updateLead(env, lead, {
      callback_status: 'pending',
      callback_next_at: isoIn(now, RETRY_AFTER_MINUTES),
      callback_ended_reason: reason,
      callback_call_id: null,
    });
    if (requeued) notes.push(`lead ${lead.id}: no answer, trying again later`);
    return;
  }

  if (outcome === 'no_answer') {
    if (!(await updateLead(env, lead, { callback_status: 'no_answer', callback_ended_reason: reason }))) return;
    notes.push(`lead ${lead.id}: no answer twice`);
    await tellKamva(env, `Hope couldn't reach ${who} — please call them`, [
      `Hope called ${who} twice about their callback request and nobody answered (last: ${reason}).`,
      "If voicemail picked up, she left a message saying you'd be in touch.",
      '',
      ...leadDetails(lead),
      '',
      SUPABASE_NOTE,
    ]);
    return;
  }

  if (outcome === 'failed') {
    await giveUp(`the call ended with "${reason}"`);
    return;
  }

  if (!(await updateLead(env, lead, {
    callback_status: 'completed',
    callback_ended_reason: reason,
    callback_summary: summary,
  }))) return;
  notes.push(`lead ${lead.id}: completed`);

  const minutes =
    call.startedAt && call.endedAt
      ? Math.max(1, Math.round((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 60_000))
      : null;
  const transcript = (call.artifact?.transcript ?? '').trim();

  await tellKamva(env, `Hope spoke to ${who}`, [
    `Hope returned ${who}'s callback request from the website and told them you would call to take it further.`,
    '',
    "Hope's notes:",
    summary ?? '(Vapi sent no summary. The transcript is below.)',
    '',
    ...leadDetails(lead),
    '',
    `Call:      ${call.startedAt ? sastLabel(new Date(call.startedAt)) : 'time unknown'}${minutes ? `, about ${minutes} min` : ''}, ended: ${reason}`,
    call.artifact?.recordingUrl ? `Recording: ${call.artifact.recordingUrl}` : '',
    '',
    'Transcript:',
    transcript
      ? transcript.length > MAX_TRANSCRIPT_CHARS
        ? `${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}\n[cut short; the full transcript is in Vapi]`
        : transcript
      : '(none)',
    '',
    SUPABASE_NOTE,
  ]);
}

// --- Starting new calls ----------------------------------------------------

async function skip(
  env: CallbackEnv,
  lead: LeadRow,
  reason: string,
  notes: string[],
  email?: { subject: string; lines: string[] },
): Promise<void> {
  if (!(await updateLead(env, lead, { callback_status: 'skipped', callback_ended_reason: reason }))) return;
  notes.push(`lead ${lead.id}: skipped (${reason})`);
  if (email) await tellKamva(env, email.subject, [...email.lines, '', ...leadDetails(lead), '', SUPABASE_NOTE]);
}

/** Returns true when a call was placed. */
async function startCall(env: CallbackEnv, lead: LeadRow, now: Date, notes: string[]): Promise<boolean> {
  const who = clean(lead.name, 80) || 'someone';

  if (lead.contacted_at) {
    await skip(env, lead, 'already contacted by the team', notes);
    return false;
  }

  const number = southAfricanNumber(lead.phone);
  if (!number) {
    await skip(env, lead, 'not a South African number', notes, {
      subject: `Hope didn't call ${who} — please call them yourself`,
      lines: [`Hope only calls South African numbers, and "${lead.phone ?? ''}" is not one she can dial.`],
    });
    return false;
  }

  const spoke = await db<{ callback_attempted_at: string }[]>(
    env,
    `leads?select=callback_attempted_at&callback_number=eq.${encodeURIComponent(number)}` +
      `&callback_status=eq.completed&callback_attempted_at=gte.${encodeURIComponent(isoIn(now, -SPOKE_RECENTLY_DAYS * 24 * 60))}` +
      `&id=neq.${encodeURIComponent(lead.id)}&order=callback_attempted_at.desc&limit=1`,
  );
  if (spoke.length > 0) {
    const when = sastLabel(new Date(spoke[0].callback_attempted_at));
    await skip(env, lead, `Hope spoke to this number on ${when}`, notes, {
      subject: `Hope didn't call ${who} again — they asked for another callback`,
      lines: [
        `${who} asked for a callback again. Hope already spoke to this number on ${when}, so she did not call a second time.`,
        'Her notes from that call were emailed then. They are probably waiting to hear from you.',
      ],
    });
    return false;
  }

  const attempt = lead.callback_attempts + 1;
  const claimed = await updateLead(env, lead, {
    callback_status: 'calling',
    callback_attempted_at: now.toISOString(),
    callback_number: number,
    callback_call_id: null,
    callback_ended_reason: null,
  });
  if (!claimed) return false;
  const calling: LeadRow = { ...lead, callback_status: 'calling', callback_attempted_at: now.toISOString() };

  let call: { id: string };
  try {
    call = await vapi<{ id: string }>(env, 'POST', '/call', {
      assistantId: env.VAPI_ASSISTANT_ID,
      phoneNumberId: env.VAPI_PHONE_NUMBER_ID,
      customer: { number, ...(clean(lead.name, 40) ? { name: clean(lead.name, 40) } : {}) },
      assistantOverrides: callbackOverrides(lead, attempt),
    });
  } catch (error) {
    if (error instanceof VapiError && (error.status >= 500 || error.status === 429)) {
      // Vapi said plainly that it did not take the call: back in the queue.
      await updateLead(env, calling, {
        callback_status: 'pending',
        callback_next_at: isoIn(now, VAPI_DOWN_RETRY_MINUTES),
        callback_ended_reason: `Vapi unavailable: ${message(error)}`.slice(0, 500),
      });
      notes.push(`lead ${lead.id}: Vapi unavailable, trying again later`);
      return false;
    }

    // Refused (a 4xx: usually a setting, a key or credit), or no answer from
    // Vapi at all, in which case the call may have gone out. Either way, a
    // person takes over rather than risk calling twice.
    const reason =
      error instanceof VapiError
        ? `Vapi refused the call: ${message(error)}`
        : `no answer from Vapi, so the call may or may not have gone out (${message(error)})`;
    if (await updateLead(env, calling, {
      callback_status: 'failed',
      callback_attempts: attempt,
      callback_ended_reason: reason.slice(0, 500),
    })) {
      notes.push(`lead ${lead.id}: failed to start`);
      await tellKamva(env, `Hope couldn't call ${who} — please call them`, [
        `Hope tried to return ${who}'s callback request, but the call could not be started.`,
        '',
        reason,
        '',
        error instanceof VapiError
          ? 'This usually means a Vapi setting needs attention (the key, the phone number, or credit). Until it is fixed, every callback will fail the same way.'
          : '',
        '',
        ...leadDetails(lead),
        '',
        SUPABASE_NOTE,
      ]);
    }
    return false;
  }

  await updateLead(env, calling, { callback_call_id: call.id, callback_attempts: attempt });
  notes.push(`lead ${lead.id}: calling (attempt ${attempt})`);
  return true;
}

async function startCalls(env: CallbackEnv, now: Date, notes: string[]): Promise<void> {
  const cutoff = encodeURIComponent(isoIn(now, -MAX_LEAD_AGE_DAYS * 24 * 60));

  // Too old to call now. Rare: only if the Worker was off, or Vapi down, for days.
  const stale = await db<LeadRow[]>(
    env,
    `leads?select=${LEAD_COLUMNS}&callback_status=eq.pending&created_at=lt.${cutoff}&limit=20`,
  );
  for (const lead of stale) {
    const who = clean(lead.name, 80) || 'someone';
    await skip(
      env,
      lead,
      `more than ${MAX_LEAD_AGE_DAYS} days old`,
      notes,
      lead.contacted_at
        ? undefined
        : {
            subject: `Hope didn't call ${who} — please call them yourself`,
            lines: [`${who}'s callback request is more than ${MAX_LEAD_AGE_DAYS} days old, too old for Hope to call out of the blue.`],
          },
    );
  }

  const called = await db<unknown[]>(
    env,
    `leads?select=id&callback_attempted_at=gte.${encodeURIComponent(isoIn(now, -24 * 60))}&limit=${DAILY_PEOPLE_CAP}`,
  );
  let budget = DAILY_PEOPLE_CAP - called.length;
  if (budget <= 0) {
    notes.push('daily cap reached');
    return;
  }

  const due = await db<LeadRow[]>(
    env,
    `leads?select=${LEAD_COLUMNS}&callback_status=eq.pending&created_at=gte.${cutoff}` +
      `&or=(callback_next_at.is.null,callback_next_at.lte.${encodeURIComponent(now.toISOString())})` +
      `&order=created_at.asc&limit=${CALLS_PER_RUN}`,
  );
  for (const lead of due) {
    if (budget <= 0) break;
    try {
      if (await startCall(env, lead, now, notes)) budget -= 1;
    } catch (error) {
      notes.push(`lead ${lead.id}: ${message(error)}`);
    }
  }
}

/**
 * One run: follow up the calls in progress (at any hour — a call that started
 * at 17:49 still needs its notes emailed), then, inside calling hours, start
 * new ones. Returns a line for the log, which names leads only by id.
 */
export async function runCallbacks(env: CallbackEnv, now = new Date()): Promise<string> {
  if (!isConfigured(env)) return 'off (the Vapi secrets are not set)';

  const notes: string[] = [];
  const inProgress = await db<LeadRow[]>(
    env,
    `leads?select=${LEAD_COLUMNS}&callback_status=eq.calling&order=callback_attempted_at.asc&limit=20`,
  );
  for (const lead of inProgress) {
    try {
      await followUp(env, lead, now, notes);
    } catch (error) {
      notes.push(`lead ${lead.id}: ${message(error)}`);
    }
  }

  if (isCallingTime(now)) {
    await startCalls(env, now, notes);
  } else if (notes.length === 0) {
    notes.push('outside calling hours');
  }
  return notes.length > 0 ? notes.join('; ') : 'nothing to do';
}
