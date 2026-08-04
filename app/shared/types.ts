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
  /** Shown once, never retrievable again. */
  temporaryPassword: string;
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
}

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

export interface MetricsResponse {
  period: Period;
  total: number;
  booked: number;
  rate: number;
  escalated: number;
  missed: number;
  trend: { label: string; count: number }[];
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
