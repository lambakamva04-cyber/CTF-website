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

export function vapiAssistantId(): string {
  return required('VAPI_ASSISTANT_ID');
}

/** Where "Book a 15-minute call" points. Calendly, SavvyCal, Cal.com — any URL. */
export function bookingUrl(): string {
  return required('BOOKING_URL');
}
