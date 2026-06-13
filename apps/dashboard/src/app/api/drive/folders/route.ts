import { NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabaseAdmin';
import { listFolders } from '@/lib/driveServer';

export const dynamic = 'force-dynamic';

/**
 * List folders in the connected Google account, for the channel folder dropdown.
 * Reads the stored refresh token (service-role) and never exposes it.
 */
export async function GET() {
  try {
    const sb = getAdminClient();
    const { data, error } = await sb
      .from('drive_auth')
      .select('refresh_token')
      .eq('id', true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data?.refresh_token) {
      return NextResponse.json(
        { error: 'No Google account connected. Connect one in Settings first.' },
        { status: 409 },
      );
    }
    return NextResponse.json(await listFolders(data.refresh_token));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
