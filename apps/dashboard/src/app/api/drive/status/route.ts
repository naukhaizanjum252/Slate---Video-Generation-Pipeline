import { NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabaseAdmin';
import type { DriveAuthStatus } from '@slate/shared';

export const dynamic = 'force-dynamic';

/**
 * Report whether a Google account is connected for Drive uploads, and which one.
 * Reads drive_auth via the service-role client — the refresh token is never
 * included in the response (only the email is surfaced).
 */
export async function GET() {
  try {
    const sb = getAdminClient();
    const { data, error } = await sb
      .from('drive_auth')
      .select('account_email, refresh_token')
      .eq('id', true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const status: DriveAuthStatus = {
      connected: Boolean(data?.refresh_token),
      account_email: data?.account_email ?? null,
    };
    return NextResponse.json(status);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
