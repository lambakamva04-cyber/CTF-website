/**
 * Keeps the Supabase project awake.
 *
 * Supabase pauses a free project after seven idle days. A paused project does
 * not degrade the demo — it breaks it completely: every link already sitting in
 * a prospect's inbox returns an error, and a cold-email link that errors is a
 * prospect you do not get a second attempt at. So this is not monitoring, it is
 * a dependency of the campaign.
 *
 * It is a separate Worker on purpose. The demo itself is built by OpenNext,
 * which generates its own `.open-next/worker.js` entrypoint and owns the
 * exports — there is no supported place to hang a `scheduled` handler off it
 * without importing a build artifact. Keeping the heartbeat apart also means an
 * adapter upgrade cannot silently take the keep-alive with it, and a broken
 * heartbeat cannot take down the demo.
 */

type Env = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
};

/**
 * The cheapest request that genuinely reaches Postgres: one indexed row, one
 * column. The point is the round trip, not the row — an empty table is a
 * perfectly good result.
 *
 * This uses the service role key rather than the anon key deliberately. `anon`
 * holds no grants on these tables by design, so a request made with it can be
 * refused at the API layer without ever touching the database, which would make
 * for a heartbeat that reports success while the project drifts towards a
 * pause.
 */
async function touchDatabase(env: Env): Promise<{ ok: boolean; detail: string }> {
  const url = `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/prospects?select=id&limit=1`;

  try {
    const response = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return { ok: false, detail: `supabase returned ${response.status}` };
    }

    await response.text();
    return { ok: true, detail: 'database reached' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'request failed' };
  }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Logged either way, and visible in `wrangler tail`. A failing heartbeat is
    // a seven-day fuse on every live demo link, so it must not fail quietly.
    ctx.waitUntil(
      touchDatabase(env).then((result) => {
        console.log(`heartbeat: ${result.ok ? 'ok' : 'FAILED'} — ${result.detail}`);
      }),
    );
  },

  /**
   * So the heartbeat can be proved on demand instead of waiting a day for the
   * next cron. It returns a bare status and no data — there is nothing here
   * worth protecting beyond that, and being able to check it in one curl is
   * worth more than the hidden surface.
   */
  async fetch(_request: Request, env: Env): Promise<Response> {
    const result = await touchDatabase(env);
    return new Response(`${result.ok ? 'ok' : 'failed'}: ${result.detail}\n`, {
      status: result.ok ? 200 : 503,
      headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
    });
  },
};
