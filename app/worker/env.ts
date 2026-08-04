export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  /** Comma-separated origins permitted to make cookie-bearing API calls. */
  ALLOWED_ORIGINS: string;

  /** Vapi private API key — used for call control fallbacks and recordings. */
  VAPI_PRIVATE_KEY?: string;
  /** Matches `server.secret` in Vapi; arrives on webhooks as x-vapi-secret. */
  VAPI_WEBHOOK_SECRET?: string;
  /** Optional: when set, x-vapi-signature HMAC is required and verified. */
  VAPI_WEBHOOK_HMAC_SECRET?: string;

  /** Override PBKDF2 work factor. Defaults to 210_000 (OWASP guidance). */
  PBKDF2_ITERATIONS?: string;

  /** Google OAuth client. Both must be set for "Continue with Google" to appear. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}
