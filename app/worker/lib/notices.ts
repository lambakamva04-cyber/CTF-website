// Telling CTF staff that something happened on a client account.

import type { AdminNoticeKind } from '../../shared/types';
import type { Env } from '../env';
import { emailConfigured, platformNoticeEmail, sendEmail } from './email';

/**
 * Records a notice for the admin console and, where email is configured, sends
 * the same one line to every active CTF admin.
 *
 * Never throws. This runs on the back of a client's own action — adding a
 * login, signing up — and that action has already succeeded; failing it
 * because CTF's inbox could not be reached would punish the client for CTF's
 * outage.
 */
export async function recordPlatformNotice(
  env: Env,
  notice: { kind: AdminNoticeKind; orgId: string; summary: string },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO platform_notifications (kind, org_id, summary, created_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(notice.kind, notice.orgId, notice.summary, Date.now())
      .run();
  } catch (error) {
    console.error('platform notice could not be recorded', error);
    return;
  }

  if (!emailConfigured(env)) return;

  try {
    const { results } = await env.DB.prepare(
      "SELECT email FROM users WHERE platform_role = 'ctf_admin' AND disabled = 0",
    ).all<{ email: string }>();
    const message = platformNoticeEmail(notice.summary);
    for (const admin of results ?? []) {
      await sendEmail(env, { to: admin.email, ...message });
    }
  } catch (error) {
    console.error('platform notice email failed', error);
  }
}
