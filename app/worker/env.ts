export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  /** Comma-separated origins permitted to make cookie-bearing API calls. */
  ALLOWED_ORIGINS: string;

  /**
   * The single address the public legal pages are published at, used for the
   * sitemap and the canonical link. Unset falls back to the request's own host
   * over https, which is right for a preview and wrong for production, where
   * the workers.dev fallback would otherwise compete with the custom domain.
   */
  CANONICAL_ORIGIN?: string;

  /** Vapi private API key — used for call control fallbacks and recordings. */
  VAPI_PRIVATE_KEY?: string;
  /** Matches `server.secret` in Vapi; arrives on webhooks as x-vapi-secret. */
  VAPI_WEBHOOK_SECRET?: string;
  /** Optional: when set, x-vapi-signature HMAC is required and verified. */
  VAPI_WEBHOOK_HMAC_SECRET?: string;

  /** Override PBKDF2 work factor. Defaults to 210_000 (OWASP guidance). */
  PBKDF2_ITERATIONS?: string;

  /**
   * 32 bytes of base64. Encrypts TOTP seeds at rest, so a database dump alone
   * does not defeat two-factor auth. Unset means TOTP enrolment is unavailable
   * — the code fails closed rather than falling back to a shared default key.
   */
  TOTP_ENCRYPTION_KEY?: string;

  /** Email provider API key. Unset means email one-time codes are unavailable. */
  EMAIL_API_KEY?: string;
  /**
   * Envelope sender. Must be a domain with SPF and DKIM published — a
   * @gmail.com sender fails DMARC and the codes land in spam.
   */
  EMAIL_FROM?: string;
  /** Where replies go: the address clients already know. */
  EMAIL_REPLY_TO?: string;

  /** Google OAuth client. Both must be set for "Continue with Google" to appear. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}
