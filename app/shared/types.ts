// API contract shared by the Worker and the React client. Keeping one copy of
// these types means a route that changes shape fails typecheck on both sides.

export type CallOutcome = 'booked' | 'inquiry' | 'escalated' | 'missed' | 'resolved';
export type CallStatus = 'ringing' | 'in-progress' | 'transferring' | 'ended';
export type Speaker = 'ai' | 'caller' | 'human' | 'system';
export type UserRole = 'owner' | 'staff';
export type Period = 'today' | 'week' | 'month';

export type Permission = 'calls:read' | 'calls:control' | 'users:manage' | 'org:manage';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  phone: string | null;
  mustChangePassword: boolean;
  /** Whether this login has a Google account bound to it. */
  googleLinked: boolean;
  /** Resolved from the role; the UI hides what the API would refuse anyway. */
  permissions: Permission[];
  /** True for Cut Through Faster staff, who can see billing totals. */
  isPlatformAdmin: boolean;
  /** False when the current policy versions have not been accepted. */
  termsAccepted: boolean;
}

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  phone: string | null;
  disabled: boolean;
  googleLinked: boolean;
  lastLoginAt: number | null;
  createdAt: number;
  /** True for the row belonging to the requester, which the UI must not disable. */
  isSelf: boolean;
}

export interface TeamResponse {
  members: TeamMember[];
}

export interface CreatedTeamMember {
  member: TeamMember;
  /**
   * Shown once, never retrievable again. Null for a Google-only login, which
   * has no password to issue.
   */
  temporaryPassword: string | null;
}

export interface AuthMethodsResponse {
  /** False when GOOGLE_CLIENT_ID/SECRET are unset, so the button stays hidden. */
  google: boolean;
  /**
   * The exact callback this hostname will send to Google. Must be registered
   * verbatim as an authorised redirect URI, or Google refuses the sign-in with
   * `redirect_uri_mismatch`.
   */
  redirectUri: string;
  /** Public — it travels in the authorize URL. Echoed back to spot typos. */
  clientId: string | null;
  /** False if the id does not end in .apps.googleusercontent.com. */
  clientIdLooksValid: boolean;
  secretPresent: boolean;
  /** Hint: current Google secrets are `GOCSPX-` prefixed. Never the value itself. */
  secretLooksValid: boolean;
  secretHadWhitespace: boolean;
}

export type OrgStatus = 'pending' | 'active' | 'suspended';

export interface SessionOrg {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  services: string[];
  /** Number that will ring on takeover when the user has no personal number. */
  takeoverNumber: string | null;
  /** False when the org has no Vapi assistant or phone number linked yet. */
  receptionistLinked: boolean;
  /** Only 'active' organizations may reach call data. */
  status: OrgStatus;
  plan: string;
}

export interface SignupStartResponse {
  authorizeUrl: string;
}

// ---------------------------------------------------------------------------
// CTF admin console. Everything below is reachable only by a ctf_admin with an
// authenticator app enrolled, and none of it carries caller data: no names,
// numbers, transcripts or recordings.
// ---------------------------------------------------------------------------

/** A client organization as the console sees it. Blocked is permanent. */
export type OrgStanding = 'active' | 'pending' | 'suspended' | 'blocked';

/**
 * Whether a login can currently use the platform. 'inactive' is a login that is
 * fine in itself but belongs to an organization that is pending or suspended.
 */
export type AccountStanding = 'active' | 'inactive' | 'disabled' | 'blocked';

export interface AdminClient {
  id: string;
  name: string;
  slug: string;
  standing: OrgStanding;
  /** Why it was last suspended or blocked, as the admin entered it. */
  statusReason: string | null;
  createdAt: number;
  activatedAt: number | null;
  logins: number;
  activeLogins: number;
  lastSignInAt: number | null;
  calls: number;
  booked: number;
  /** Booked as a percentage of every call taken, missed calls included. */
  bookingRate: number;
  /** Minutes against this client's own plan, each call rounded up. */
  billing: BillingSummary;
}

export type AdminPeriod = 'this-month' | 'last-month';

export interface AdminOverview {
  period: AdminPeriod;
  clients: AdminClient[];
  totals: {
    clients: number;
    active: number;
    pending: number;
    suspended: number;
    blocked: number;
    calls: number;
    booked: number;
    minutesUsed: number;
    extraMinutes: number;
    extraCostZar: number;
  };
}

export interface AdminAccount {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  orgId: string;
  orgName: string;
  standing: AccountStanding;
  /** Set when CTF disabled or blocked this login: why. */
  holdReason: string | null;
  lastSignInAt: number | null;
  createdAt: number;
}

export interface AdminAccountsResponse {
  accounts: AdminAccount[];
  totals: { total: number; active: number; inactive: number };
}

export interface AdminActivityItem {
  id: number;
  at: number;
  /** A fixed label for the action; never the raw audit detail. */
  label: string;
  orgName: string | null;
  actorName: string | null;
  /** True when a CTF admin did it. */
  byCtf: boolean;
}

export interface AdminActivityResponse {
  items: AdminActivityItem[];
  nextCursor: number | null;
}

export type AdminNoticeKind = 'login_added' | 'org_signup';

export interface AdminNotice {
  id: number;
  kind: AdminNoticeKind;
  summary: string;
  at: number;
  read: boolean;
}

export interface AdminNoticesResponse {
  unread: number;
  items: AdminNotice[];
}

export interface StepUpResponse {
  /** Destructive console actions are allowed until this time (epoch ms). */
  steppedUpUntil: number;
}

export type OrgAction = 'activate' | 'suspend' | 'block';
export type AccountAction = 'disable' | 'enable' | 'block';

/**
 * What /api/auth/login answers with when the password was right but the account
 * carries a second factor. Nothing here is a credential: the challenge id names
 * a server-side row and grants no access until a code is verified against it.
 */
export interface TwoFactorChallenge {
  twoFactorRequired: true;
  challengeId: string;
  method: 'totp' | 'email';
  /** Masked address for the email method, so the client knows where to look. */
  sentTo: string | null;
}

export type LoginResponse = MeResponse | TwoFactorChallenge;

export function isTwoFactorChallenge(value: LoginResponse): value is TwoFactorChallenge {
  return (value as TwoFactorChallenge).twoFactorRequired === true;
}

export type TwoFactorMethod = 'none' | 'totp' | 'email';

export interface TwoFactorStatus {
  method: TwoFactorMethod;
  /** An enrolment started but never confirmed; the UI offers to resume it. */
  pendingTotp: boolean;
  backupCodesRemaining: number;
  /** False when TOTP_ENCRYPTION_KEY is unset, so the UI can say why. */
  totpAvailable: boolean;
  /** False when no email provider is configured. */
  emailAvailable: boolean;
}

export interface TotpEnrollment {
  /** Shown once, for someone typing it in rather than scanning. */
  secret: string;
  otpauthUri: string;
}

export interface BackupCodesResponse {
  backupCodes: string[];
}

export interface MeResponse {
  user: SessionUser;
  org: SessionOrg;
}

export interface CallSummary {
  id: string;
  status: CallStatus;
  callerName: string | null;
  callerNumber: string | null;
  startedAt: number;
  endedAt: number | null;
  durationS: number | null;
  intent: string | null;
  outcome: CallOutcome | null;
  service: string | null;
  bookingWhen: string | null;
  takenOverBy: string | null;
  takenOverAt: number | null;
}

export interface CallDetail extends CallSummary {
  summary: string | null;
  recordingUrl: string | null;
  endedReason: string | null;
  transferTo: string | null;
  /** True while Vapi still exposes a control endpoint for this call. */
  controllable: boolean;
}

export interface TranscriptLine {
  seq: number;
  speaker: Speaker;
  text: string;
  at: number;
}

export interface TranscriptResponse {
  callId: string;
  lines: TranscriptLine[];
  /** Highest seq returned; pass back as `after` to fetch only new lines. */
  cursor: number;
  complete: boolean;
}

export interface LiveResponse {
  call: CallDetail | null;
  /** Server clock, so the client can show call duration without drifting. */
  now: number;
}

export interface CallsResponse {
  calls: CallSummary[];
  nextCursor: string | null;
}

/**
 * Usage against the client's plan for the CURRENT CALENDAR MONTH.
 *
 * Deliberately not affected by `period`: the call stats above answer "how is
 * the receptionist doing this week", while this answers "what will the invoice
 * say", and the invoice is monthly whichever toggle happens to be selected.
 */
export interface BillingSummary {
  /** Minutes this month, each call rounded up to a whole minute before summing. */
  minutesUsed: number;
  /** Minutes included in the subscription. */
  planMinutes: number;
  /** Minutes beyond the plan. Zero when under. */
  extraMinutes: number;
  /** Rand owed for `extraMinutes`, rounded to cents. Zero when under. */
  extraCostZar: number;
  /** The client's own monthly fee, excluding overage. */
  subscriptionZar: number;
  /** The client's own per-minute rate beyond the plan. */
  overageRateZar: number;
}

export interface MetricsResponse {
  period: Period;
  total: number;
  booked: number;
  rate: number;
  escalated: number;
  missed: number;
  trend: { label: string; count: number }[];
  /** Always the calendar month, regardless of `period`. */
  billing: BillingSummary;
}

export interface TakeoverResponse {
  call: CallDetail;
  /** The number actually rung, echoed back so the UI can name it. */
  ringing: string;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  /** Present on 429 responses: seconds until the caller may retry. */
  retryAfter?: number;
}
