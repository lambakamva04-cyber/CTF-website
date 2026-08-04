import type { MetricsResponse, Period } from '../../shared/types';
import type { Env } from '../env';
import type { AuthContext } from '../lib/auth';
import { badRequest, json } from '../lib/http';
import {
  isValidTimeZone,
  localWeekdayLabel,
  startOfLocalDay,
  startOfLocalMonth,
  startOfLocalWeek,
} from '../lib/time';

interface OutcomeCounts {
  total: number | null;
  booked: number | null;
  escalated: number | null;
  missed: number | null;
}

function parsePeriod(value: string | null): Period {
  if (value === 'today' || value === 'week' || value === 'month') return value;
  throw badRequest('Period must be today, week or month.');
}

export async function handleMetrics(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const period = parsePeriod(new URL(request.url).searchParams.get('period') ?? 'today');
  const timeZone = isValidTimeZone(auth.org.timezone) ? auth.org.timezone : 'Africa/Johannesburg';
  const now = new Date();

  const from =
    period === 'today'
      ? startOfLocalDay(now, timeZone)
      : period === 'week'
        ? startOfLocalWeek(now, timeZone)
        : startOfLocalMonth(now, timeZone);

  // Missed calls still count as "calls taken" in the denominator: a client
  // measuring their receptionist wants the booking rate across every call that
  // came in, not only the ones that connected.
  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN outcome = 'booked' THEN 1 ELSE 0 END) AS booked,
            SUM(CASE WHEN outcome = 'escalated' THEN 1 ELSE 0 END) AS escalated,
            SUM(CASE WHEN outcome = 'missed' THEN 1 ELSE 0 END) AS missed
       FROM calls
      WHERE org_id = ? AND started_at >= ?`,
  )
    .bind(auth.org.id, from)
    .first<OutcomeCounts>();

  const total = counts?.total ?? 0;
  const booked = counts?.booked ?? 0;

  const payload: MetricsResponse = {
    period,
    total,
    booked,
    rate: total > 0 ? Math.round((booked / total) * 100) : 0,
    escalated: counts?.escalated ?? 0,
    missed: counts?.missed ?? 0,
    trend: await buildTrend(env, auth.org.id, period, timeZone, now),
  };

  return json(payload);
}

async function buildTrend(
  env: Env,
  orgId: string,
  period: Period,
  timeZone: string,
  now: Date,
): Promise<{ label: string; count: number }[]> {
  if (period === 'today') return [];

  const buckets: { label: string; from: number; to: number }[] = [];

  if (period === 'week') {
    for (let i = 6; i >= 0; i--) {
      const from = startOfLocalDay(now, timeZone, -i);
      const to = startOfLocalDay(now, timeZone, -i + 1);
      buckets.push({ label: localWeekdayLabel(from, timeZone), from, to });
    }
  } else {
    for (let i = 4; i >= 0; i--) {
      const from = startOfLocalDay(now, timeZone, -(i * 7 + 6));
      const to = startOfLocalDay(now, timeZone, -(i * 7) + 1);
      buckets.push({ label: i === 0 ? 'This wk' : `-${i}w`, from, to });
    }
  }

  const statements = buckets.map((bucket) =>
    env.DB.prepare(
      'SELECT COUNT(*) AS count FROM calls WHERE org_id = ? AND started_at >= ? AND started_at < ?',
    ).bind(orgId, bucket.from, bucket.to),
  );

  const results = await env.DB.batch<{ count: number }>(statements);

  return buckets.map((bucket, index) => ({
    label: bucket.label,
    count: results[index]?.results?.[0]?.count ?? 0,
  }));
}
