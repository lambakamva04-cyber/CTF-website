// Request throttling.
//
// Fixed-window counters in D1. A sliding window would be more precise, but it
// needs per-request timestamps; fixed windows cost one row and one statement,
// which matters when the limiter runs on every request. The trade-off is that a
// caller can burst across a window boundary — acceptable here, because the
// limits exist to stop scraping and hammering, not to meter a paid API.

import type { Env } from '../env';
import { tooManyRequests } from './http';

export interface RateLimitRule {
  /** Distinguishes counters, so read and write budgets do not share one. */
  name: string;
  limit: number;
  windowMs: number;
}

/**
 * Reads are polled constantly by the dashboard — live call every 3s and
 * transcript every 2s per open tab — so this has to sit well above normal use
 * while still stopping a scraper.
 */
export const READ_RULE: RateLimitRule = { name: 'read', limit: 600, windowMs: 60_000 };

/** Mutations are human-paced; nothing legitimate comes close to this. */
export const WRITE_RULE: RateLimitRule = { name: 'write', limit: 60, windowMs: 60_000 };

/** Creating organizations from one address, to blunt automated signups. */
export const SIGNUP_RULE: RateLimitRule = { name: 'signup', limit: 5, windowMs: 60 * 60_000 };

/**
 * Vapi can burst several events per second on a busy line, and dropping a
 * webhook loses a transcript line permanently, so this is deliberately loose —
 * it is a backstop against a runaway loop, not a business limit.
 */
export const WEBHOOK_RULE: RateLimitRule = { name: 'webhook', limit: 3_000, windowMs: 60_000 };

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Counts one request against `subject` under `rule`.
 *
 * The increment is a single upsert so two concurrent requests cannot both read
 * the same count and write back the same value — the classic way a limiter is
 * quietly bypassed under exactly the load it exists to handle.
 */
export async function consume(
  env: Env,
  subject: string,
  rule: RateLimitRule,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs;
  const expiresAt = windowStart + rule.windowMs;
  const bucket = `${rule.name}:${subject}:${windowStart}`;

  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, hits, window_start, expires_at)
     VALUES (?1, 1, ?2, ?3)
     ON CONFLICT (bucket) DO UPDATE SET hits = hits + 1
     RETURNING hits`,
  )
    .bind(bucket, windowStart, expiresAt)
    .first<{ hits: number }>();

  const hits = row?.hits ?? 1;

  return {
    allowed: hits <= rule.limit,
    remaining: Math.max(0, rule.limit - hits),
    retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1000)),
  };
}

/** Consumes a request and throws 429 when the budget is spent. */
export async function enforce(
  env: Env,
  subject: string,
  rule: RateLimitRule,
  message = 'Too many requests. Please slow down and try again shortly.',
): Promise<RateLimitResult> {
  const result = await consume(env, subject, rule);
  if (!result.allowed) throw tooManyRequests(message, result.retryAfterSeconds);
  return result;
}

/**
 * Who is being limited. A signed-in user is limited as themselves, so one
 * client on a shared office IP cannot exhaust another's budget; everyone else
 * falls back to their address.
 */
export function subjectFor(userId: string | null, ip: string): string {
  return userId ? `u:${userId}` : `ip:${ip}`;
}

export async function pruneRateLimits(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(Date.now()).run();
}
