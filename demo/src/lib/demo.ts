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

/**
 * The kinds of business a demo can be prepared for. Each has its own words on
 * the page and its own Vapi assistant: the dental one introduces itself as a
 * dental practice's receptionist, so a law firm must never reach it.
 */
export const INDUSTRIES = ['dental', 'legal'] as const;

export type Industry = (typeof INDUSTRIES)[number];

export function isIndustry(value: unknown): value is Industry {
  return typeof value === 'string' && (INDUSTRIES as readonly string[]).includes(value);
}

/** The words that differ between a dental practice's page and a law firm's. */
export type IndustryCopy = {
  /** "Practice" or "Firm", as a label. */
  businessLabel: string;
  /** "your practice name" / "your firm's name". */
  yourName: string;
  /** "Services" or "Practice areas", as a label. */
  servicesLabel: string;
  /** "your services" / "your practice areas". */
  yourServices: string;
  /** Who is at the counter while the phone rings. */
  personAtCounter: string;
  /** What Hope takes when she answers. */
  takes: string;
  /** Said to Hope when the row has no services listed. */
  fallbackServices: string;
  /** What to try on the call. */
  tryAsking: string;
};

export const INDUSTRY_COPY: Record<Industry, IndustryCopy> = {
  dental: {
    businessLabel: 'Practice',
    yourName: 'your practice name',
    servicesLabel: 'Services',
    yourServices: 'your services',
    personAtCounter: 'a patient at the counter',
    takes: 'takes the booking',
    fallbackServices: 'general dentistry',
    tryAsking:
      'Ask her for an appointment on Thursday morning, or what time you close on a Saturday. She answers as though she is sitting behind your front desk.',
  },
  legal: {
    businessLabel: 'Firm',
    yourName: 'your firm’s name',
    servicesLabel: 'Practice areas',
    yourServices: 'your practice areas',
    personAtCounter: 'a client at reception',
    takes: 'takes the enquiry',
    fallbackServices: 'general legal services',
    tryAsking:
      'Call as a new client: ask to book a consultation for Thursday morning, or what time you close on a Friday. She answers as though she is sitting at your reception.',
  },
};

/**
 * "your practice name, your services and your hours" — what Hope was told
 * about this prospect, for the line after a call. Hours are only claimed when
 * the row has them.
 */
export function describePrimedWith(industry: Industry, hasHours: boolean): string {
  const copy = INDUSTRY_COPY[industry];
  return hasHours
    ? `${copy.yourName}, ${copy.yourServices} and your hours`
    : `${copy.yourName} and ${copy.yourServices}`;
}

/** The only prospect fields the browser is ever given. */
export type PublicProspect = {
  slug: string;
  /** Which words and which assistant this page uses. */
  industry: Industry;
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
