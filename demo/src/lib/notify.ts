import 'server-only';

import { emailApiKey, emailFrom, leadNotifyTo } from './env';
import type { LeadInput } from './leads';

// The request shape is Resend's, as in the dashboard's worker/lib/email.ts.
const ENDPOINT = 'https://api.resend.com/emails';

/** Long enough for a slow provider, short enough not to hang the form. */
const TIMEOUT_MS = 8_000;

/** One line, no control characters: it becomes an email header. */
function headerSafe(text: string, max: number): string {
  return text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

/**
 * Emails a new callback request to the CTF inbox, so it is seen without
 * anyone having to look in Supabase. Plain text: every field in it was typed
 * by a stranger.
 *
 * Returns false when email is not configured. Throws when the provider refuses
 * or does not answer; the caller decides what that means — for the callback
 * form, the request is already saved, so it only logs.
 */
export async function emailNewLead(lead: LeadInput, receivedAt: Date): Promise<boolean> {
  const apiKey = emailApiKey();
  if (!apiKey) return false;

  const when = new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(receivedAt);

  const text = [
    'Someone asked for a callback on cutthroughfaster.com.',
    '',
    `Name:      ${lead.name}`,
    `Business:  ${lead.businessType ?? 'not given'}`,
    `Phone:     ${lead.phone}`,
    `Message:   ${lead.message ?? '(none)'}`,
    '',
    `Sent ${when} (South African time).`,
    '',
    'The site told them to expect a call, usually the same day. The request is',
    'also saved in Supabase → Table Editor → leads; set contacted_at once you',
    'have called back.',
  ].join('\n');

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: emailFrom(),
      to: [leadNotifyTo()],
      subject: `Callback request: ${headerSafe(lead.name, 80)}`,
      text,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`email provider answered ${response.status}: ${detail.slice(0, 300)}`);
  }
  return true;
}
