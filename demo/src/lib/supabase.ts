import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { supabaseServiceRoleKey, supabaseUrl } from './env';

let client: SupabaseClient | null = null;

/**
 * How long one database request may take. Every query here is a single-row
 * lookup or a count on a small table, so this is minutes of headroom over
 * normal — its job is to turn a hung connection into an error the route
 * answers, instead of a visitor watching a spinner until the Worker is killed.
 */
const REQUEST_TIMEOUT_MS = 8_000;

const fetchWithTimeout: typeof fetch = (input, init) => {
  // Aborted with no reason, so the request fails with an AbortError. That
  // matters: the client retries a failed read up to three times on its own,
  // but never an aborted one. A TimeoutError would be retried, and a hung
  // database would hold the visitor for four timeouts instead of one. Fast
  // failures, the kind a retry actually fixes, are still retried.
  const controller = new AbortController();
  setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  return fetch(input, { ...init, signal });
};

/**
 * The service role client. It bypasses RLS, so it must never be constructed in
 * a module that can end up in the browser bundle — hence `server-only` at the
 * top of this file and of every module that imports it.
 */
export function db(): SupabaseClient {
  if (!client) {
    client = createClient(supabaseUrl(), supabaseServiceRoleKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: fetchWithTimeout },
    });
  }
  return client;
}
