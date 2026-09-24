// Outbound email. Every provider-specific detail lives here — the one file to
// change if you swap providers, in the same way worker/lib/vapi.ts is the one
// file that knows about Vapi.
//
// Workers cannot open SMTP connections, so this is an HTTPS API rather than a
// mail server. The request shape below is Resend's; SendGrid, Postmark and
// Mailgun differ only in the URL, the auth header and two field names.
//
// ---------------------------------------------------------------------------
// About sending "from" cutthroughfaster@gmail.com
//
// It cannot be done, and the reason is worth stating plainly rather than
// discovering it in a spam folder. gmail.com publishes an SPF record that
// authorises Google's servers and nobody else, and Google does not let you add
// a third party to it — the domain is not yours. Any provider sending as
// @gmail.com therefore fails SPF, fails DKIM alignment, and fails DMARC. Gmail
// and Outlook mostly reject such mail outright; a one-time code that lands in
// spam is worse than no second factor, because people turn it on and then
// cannot sign in.
//
// So mail is sent from a subdomain of cutthroughfaster.com, which CTF does
// control and can publish SPF and DKIM for, and the CTF gmail address is put in
// Reply-To. Clients still reach a human at the address they know; the codes
// still arrive.
// ---------------------------------------------------------------------------

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super('Email is not configured on this deployment, so codes cannot be sent.');
    this.name = 'EmailNotConfiguredError';
  }
}

export class EmailSendError extends Error {
  constructor(public readonly status: number, public readonly detail: string) {
    super(`The email provider rejected the message (${status}).`);
    this.name = 'EmailSendError';
  }
}

export interface EmailEnv {
  /** Provider API key. Without it, email delivery is off. */
  EMAIL_API_KEY?: string;
  /** Envelope sender. Must be a domain with SPF and DKIM published. */
  EMAIL_FROM?: string;
  /** Where replies go — the address clients already know. */
  EMAIL_REPLY_TO?: string;
}

const DEFAULT_FROM = 'Cut Through Faster <security@mail.cutthroughfaster.com>';
const DEFAULT_REPLY_TO = 'cutthroughfaster@gmail.com';
const ENDPOINT = 'https://api.resend.com/emails';

export function emailConfigured(env: EmailEnv): boolean {
  return Boolean(env.EMAIL_API_KEY?.trim());
}

/**
 * Diagnostics for the sign-in screen and the health check. Deliberately reports
 * whether a key is present, never any part of its value.
 */
export function emailDiagnostics(env: EmailEnv): {
  configured: boolean;
  from: string;
  replyTo: string;
  fromLooksDeliverable: boolean;
} {
  const from = env.EMAIL_FROM?.trim() || DEFAULT_FROM;
  // A free-mail sender is the single most likely misconfiguration here, and it
  // fails silently at the recipient rather than at send time. Surfacing it is
  // the difference between a five-minute fix and a week of "codes never arrive".
  const fromLooksDeliverable = !/@(gmail|googlemail|yahoo|outlook|hotmail)\.com/i.test(from);

  return {
    configured: emailConfigured(env),
    from,
    replyTo: env.EMAIL_REPLY_TO?.trim() || DEFAULT_REPLY_TO,
    fromLooksDeliverable,
  };
}

export async function sendEmail(env: EmailEnv, message: EmailMessage): Promise<void> {
  const apiKey = env.EMAIL_API_KEY?.trim();
  if (!apiKey) throw new EmailNotConfiguredError();

  const { from, replyTo } = emailDiagnostics(env);

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [message.to],
      reply_to: replyTo,
      subject: message.subject,
      text: message.text,
    }),
  });

  if (!response.ok) {
    // Read the body for the log, but never return it to the caller: provider
    // errors quote the recipient address back, and the sign-in screen must not
    // confirm whether an address exists here.
    const detail = await response.text().catch(() => '');
    throw new EmailSendError(response.status, detail.slice(0, 500));
  }
}

/** The one-time code email. Plain text: it is six digits and a warning. */
export function verificationCodeEmail(options: {
  code: string;
  minutesValid: number;
  ip: string | null;
}): { subject: string; text: string } {
  const from = options.ip ? ` from ${options.ip}` : '';
  return {
    subject: `${options.code} is your Cut Through Faster sign-in code`,
    text: [
      `Your sign-in code is ${options.code}.`,
      '',
      `It expires in ${options.minutesValid} minutes and can be used once.`,
      '',
      `Somebody just tried to sign in to your dashboard${from}. If that was not`,
      'you, do not enter this code. Your password or Google account still works,',
      'so change it and tell us at cutthroughfaster@gmail.com.',
      '',
      'Cut Through Faster will never ask you for this code by phone or email.',
    ].join('\n'),
  };
}

/**
 * Sent to a CTF admin every time their account signs in. The alert goes to the
 * inbox rather than the console on purpose: someone who has stolen the account
 * is the one looking at the console.
 */
export function adminSignInEmail(options: {
  when: string;
  ip: string | null;
  userAgent: string | null;
}): { subject: string; text: string } {
  return {
    subject: 'New sign-in to the CTF admin console',
    text: [
      'Your Cut Through Faster admin account just signed in.',
      '',
      `When: ${options.when}`,
      `From: ${options.ip ?? 'unknown address'}`,
      `Browser: ${options.userAgent?.slice(0, 120) ?? 'unknown'}`,
      '',
      'If this was not you, change the password and reset the authenticator app',
      'for this account straight away. This account can suspend every client.',
    ].join('\n'),
  };
}

/**
 * Tells CTF staff that something happened on a client account. Minimal by
 * design: which organization and what happened, never who was added or their
 * address. The detail is in the console for someone signed in to see.
 */
export function platformNoticeEmail(summary: string): { subject: string; text: string } {
  return {
    subject: `CTF platform: ${summary}`,
    text: [summary, '', 'Sign in to the CTF admin console for details.'].join('\n'),
  };
}

