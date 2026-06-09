import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** True only when both public env vars are present. */
export const isSupabaseConfigured = Boolean(url && anonKey);

if (!isSupabaseConfigured) {
  // Surface misconfiguration clearly without crashing the app.
  // eslint-disable-next-line no-console
  console.warn(
    'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
      'Copy .env.example to .env.local and fill them in. ' +
      'The dashboard will render but show no data until configured.',
  );
}

// Only construct the client when configured — createClient throws on an empty
// URL, which would 500 the whole page. When unconfigured we export null and the
// UI shows a friendly "not configured" notice instead.
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url as string, anonKey as string, { auth: { persistSession: false } })
  : null;
