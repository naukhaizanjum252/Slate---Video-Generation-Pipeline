import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabaseAdmin';
import { exchangeCode, accessTokenFromRefresh, fetchAccountEmail } from '@/lib/driveServer';

export const dynamic = 'force-dynamic';

/**
 * Google redirects here after consent. Exchange the code for a refresh token,
 * look up the account email, and store both in drive_auth (single row, upsert
 * on id=true) via the service-role client. Then bounce back to Settings.
 */
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const settings = (params: Record<string, string>) => {
    const url = new URL('/settings', origin);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return NextResponse.redirect(url);
  };

  const error = req.nextUrl.searchParams.get('error');
  if (error) return settings({ drive_error: `Google denied access: ${error}` });

  const code = req.nextUrl.searchParams.get('code');
  if (!code) return settings({ drive_error: 'Missing authorization code from Google' });

  try {
    const tokens = await exchangeCode(code, origin);
    if (!tokens.refresh_token) {
      // Google only returns a refresh token with prompt=consent + offline access.
      // If it's missing, the prior grant must be revoked and re-consented.
      return settings({
        drive_error:
          'Google did not return a refresh token. Revoke access at ' +
          'myaccount.google.com/permissions and connect again.',
      });
    }

    // Best-effort email lookup for display; never block the connect on it.
    let email: string | null = null;
    try {
      email = await fetchAccountEmail(tokens.access_token);
    } catch {
      /* ignore — email is cosmetic */
    }

    const sb = getAdminClient();
    const { error: dbError } = await sb.from('drive_auth').upsert(
      {
        id: true,
        refresh_token: tokens.refresh_token,
        account_email: email,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    );
    if (dbError) throw new Error(dbError.message);

    return settings({ drive: 'connected' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return settings({ drive_error: message });
  }
}
