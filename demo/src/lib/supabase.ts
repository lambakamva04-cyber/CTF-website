import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { supabaseServiceRoleKey, supabaseUrl } from './env';

let client: SupabaseClient | null = null;

/**
 * The service role client. It bypasses RLS, so it must never be constructed in
 * a module that can end up in the browser bundle — hence `server-only` at the
 * top of this file and of every module that imports it.
 */
export function db(): SupabaseClient {
  if (!client) {
    client = createClient(supabaseUrl(), supabaseServiceRoleKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
