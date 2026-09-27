import 'server-only';

import { db } from './supabase';

/**
 * Requests allowed from one sender in an hour. Enough for a typo and a retry,
 * not enough to fill the table from one machine.
 */
const PER_SENDER_PER_HOUR = 5;

/** Requests allowed in a day across everyone: a ceiling on a scripted flood. */
const GLOBAL_PER_DAY = 200;

export type LeadInput = {
  name: string;
  businessType: string | null;
  phone: string;
  message: string | null;
  ipHash: string | null;
  userAgent: string | null;
};

/** True when this sender, or everyone together, has sent enough for now. */
export async function leadLimitReached(ipHash: string | null): Promise<boolean> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: dayCount, error: dayError } = await db()
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .gt('created_at', dayAgo);

  if (dayError) throw new Error(`lead count failed: ${dayError.message}`);
  if ((dayCount ?? 0) >= GLOBAL_PER_DAY) return true;

  if (!ipHash) return false;

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: senderCount, error: senderError } = await db()
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('ip_hash', ipHash)
    .gt('created_at', hourAgo);

  if (senderError) throw new Error(`lead count failed: ${senderError.message}`);
  return (senderCount ?? 0) >= PER_SENDER_PER_HOUR;
}

export async function saveLead(input: LeadInput): Promise<void> {
  const { error } = await db().from('leads').insert({
    name: input.name,
    business_type: input.businessType,
    phone: input.phone,
    message: input.message,
    source: 'website',
    ip_hash: input.ipHash,
    user_agent: input.userAgent,
  });

  if (error) throw new Error(`lead insert failed: ${error.message}`);
}
