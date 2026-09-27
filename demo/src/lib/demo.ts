// Shared between the server routes and the browser bundle. Nothing in here may
// import server-only modules or read a secret.

/**
 * Hard cap on a demo conversation, in seconds.
 *
 * Vapi bills per minute and this product has no revenue yet. The browser stops
 * the call at this mark and the same number is sent to Vapi as
 * `maxDurationSeconds`, so a tampered client cannot run up a bill either.
 * Three minutes is enough for a prospect to hear Hope take a booking. Raising
 * it is a spend decision, not a UI tweak.
 */
export const DEMO_MAX_SECONDS = 180;

/**
 * The public line's cap if `demo_limits` cannot be read. The live number is
 * `demo_limits.max_seconds`, so it can be changed without a deploy.
 */
export const PUBLIC_LINE_FALLBACK_SECONDS = 60;

export const DEMO_EVENT_TYPES = [
  'page_view',
  'call_started',
  'call_ended',
  'mic_denied',
  'link_expired',
] as const;

export type DemoEventType = (typeof DEMO_EVENT_TYPES)[number];

export function isDemoEventType(value: unknown): value is DemoEventType {
  return typeof value === 'string' && (DEMO_EVENT_TYPES as readonly string[]).includes(value);
}

/** Slugs are the entire link. Lowercase, hyphens, nothing exotic. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_PATTERN.test(value);
}

/** The only prospect fields the browser is ever given. */
export type PublicProspect = {
  slug: string;
  practice_name: string;
  suburb: string | null;
  services: string[];
  hours: string | null;
  /** True once a call has been started on this link. */
  expired: boolean;
  /**
   * The always-on line on the marketing site. Never spent, but rate limited,
   * and every call is checked with POST /api/demo/[slug]/gate first.
   */
  public_line: boolean;
};

/** Body accepted by POST /api/demo/[slug]/event. */
export type DemoEventBody = {
  event_type: DemoEventType;
  duration_seconds?: number | null;
  ended_reason?: string | null;
};

/** Why the public line turned a call away. */
export type GateRefusal = 'ip_cooldown' | 'daily_cap';

/** Returned by POST /api/demo/[slug]/gate. */
export type GateResponse =
  | { allowed: true; max_seconds: number }
  | { allowed: false; reason: GateRefusal };

/** "one minute", "three minutes", "90 seconds" — for copy, not countdowns. */
export function describeDuration(totalSeconds: number): string {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five'];
  if (totalSeconds % 60 !== 0) return `${totalSeconds} seconds`;
  const minutes = totalSeconds / 60;
  const count = words[minutes] ?? String(minutes);
  return `${count} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/**
 * The practice name as Hope should say it. A trailing note in brackets, such
 * as "(demo practice)" on the public line's sample practice, is for the page,
 * not to be read aloud.
 */
export function spokenPracticeName(practiceName: string): string {
  return practiceName.replace(/\s*\([^)]*\)\s*$/, '').trim() || practiceName;
}

export function formatCountdown(secondsRemaining: number): string {
  const clamped = Math.max(0, Math.floor(secondsRemaining));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** "general dentistry, implants and orthodontics" — for prose, not lists. */
export function joinServices(services: string[]): string {
  if (services.length === 0) return '';
  if (services.length === 1) return services[0];
  return `${services.slice(0, -1).join(', ')} and ${services[services.length - 1]}`;
}
