import 'server-only';

/**
 * Environment is read per request, never at module load. A missing variable
 * must fail the request with a readable message rather than the build — the
 * build runs in CI without secrets, and the page is dynamic anyway.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  }
  return value;
}

export function supabaseUrl(): string {
  return required('SUPABASE_URL');
}

export function supabaseServiceRoleKey(): string {
  return required('SUPABASE_SERVICE_ROLE_KEY');
}

/**
 * Vapi browser credentials. These are handed to the client component as props
 * rather than inlined as NEXT_PUBLIC_* at build time, so rotating the key or
 * pointing at a different assistant is a `wrangler secret put` and a redeploy
 * of the same build — not a rebuild.
 */
export function vapiPublicKey(): string {
  return required('VAPI_PUBLIC_KEY');
}

/**
 * The dental assistant (vapi/assistant.md) that every dental link already in an
 * inbox uses. To move dental links to Hope, set this to Hope's ID too: the page
 * already sends her the industry on every call.
 */
export function vapiAssistantId(): string {
  return required('VAPI_ASSISTANT_ID');
}

/**
 * Hope, the one assistant for every industry (vapi/hope-prompt.md). The page
 * tells her on each call which industry's section of her prompt to follow.
 * Optional: until it is set, a law firm's link is a 404 and the public line
 * stays the dental sample on the dental assistant, with no industry picker.
 */
export function vapiHopeAssistantId(): string | null {
  return process.env.VAPI_HOPE_ASSISTANT_ID?.trim() || null;
}

/** Where "Book a 15-minute call" points. Calendly, SavvyCal, Cal.com — any URL. */
export function bookingUrl(): string {
  return required('BOOKING_URL');
}

/**
 * Salt for the one-way hash of a caller's IP address, which is all the public
 * line's per-person limit and the callback form's flood limit ever store.
 *
 * Optional on purpose. Without it no hash is made, the per-person limit is
 * skipped, and the public line falls back on its daily cap alone — a request
 * still works, and a callback request is still saved.
 */
export function demoIpSalt(): string | null {
  return process.env.DEMO_IP_SALT || null;
}

/**
 * The email provider's key (Resend), under the same name the dashboard uses.
 * Optional: without it a callback request is still saved, and nobody is
 * emailed about it.
 */
export function emailApiKey(): string | null {
  return process.env.EMAIL_API_KEY?.trim() || null;
}

/** Sender for the callback email. Must be on a domain verified with Resend. */
export function emailFrom(): string {
  return (
    process.env.EMAIL_FROM?.trim() || 'CTF website <website@mail.cutthroughfaster.com>'
  );
}

/** Who is told about a new callback request. */
export function leadNotifyTo(): string {
  return process.env.LEAD_NOTIFY_TO?.trim() || 'hello@cutthroughfaster.com';
}
