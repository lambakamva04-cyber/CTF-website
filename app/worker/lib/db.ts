// Row shapes as stored in D1. These mirror migrations/0001_init.sql exactly;
// mapping to the API types in shared/types.ts happens at the route layer.

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  services: string;
  vapi_assistant_id: string | null;
  vapi_phone_number_id: string | null;
  takeover_number: string | null;
  created_at: number;
  updated_at: number;
}

export interface UserRow {
  id: string;
  org_id: string;
  email: string;
  name: string;
  role: 'owner' | 'staff';
  phone: string | null;
  password_hash: string;
  must_change_password: number;
  disabled: number;
  last_login_at: number | null;
  google_sub: string | null;
  google_linked_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * Stored in `password_hash` for logins that exist only for Google sign-in.
 * `verifyPassword` rejects anything that is not five `$`-separated fields, so
 * this can never be matched by a submitted password.
 */
export const UNUSABLE_PASSWORD_HASH = '!';

export interface CallRow {
  id: string;
  org_id: string;
  vapi_call_id: string;
  control_url: string | null;
  listen_url: string | null;
  status: 'ringing' | 'in-progress' | 'transferring' | 'ended';
  caller_name: string | null;
  caller_number: string | null;
  started_at: number;
  answered_at: number | null;
  ended_at: number | null;
  duration_s: number | null;
  intent: string | null;
  outcome: 'booked' | 'inquiry' | 'escalated' | 'missed' | 'resolved' | null;
  service: string | null;
  booking_when: string | null;
  summary: string | null;
  recording_url: string | null;
  ended_reason: string | null;
  taken_over_by: string | null;
  taken_over_at: number | null;
  transfer_to: string | null;
  updated_at: number;
}

export interface TranscriptRow {
  seq: number;
  speaker: 'ai' | 'caller' | 'human' | 'system';
  text: string;
  at: number;
}

export function parseServices(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

export async function writeAudit(
  db: D1Database,
  entry: {
    orgId: string | null;
    userId: string | null;
    action: string;
    target?: string | null;
    detail?: string | null;
    ip?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (org_id, user_id, action, target, detail, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      entry.orgId,
      entry.userId,
      entry.action,
      entry.target ?? null,
      entry.detail ?? null,
      entry.ip ?? null,
      Date.now(),
    )
    .run();
}
