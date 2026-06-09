import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Server-only Supabase client using the service-role key. Never import this
// from a client component — it must only run inside route handlers.
let cached: SupabaseClient | null = null;

export function getAdminClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the dashboard server env.',
    );
  }
  cached = createClient(url, serviceKey, { auth: { persistSession: false } });
  return cached;
}
