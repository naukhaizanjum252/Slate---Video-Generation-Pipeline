import { NextRequest, NextResponse } from 'next/server';
import { buildAuthUrl } from '@/lib/driveServer';

export const dynamic = 'force-dynamic';

/**
 * Kick off the Google connect flow: redirect the user to Google's consent
 * screen. Google sends them back to /api/drive/oauth/callback with a code.
 */
export async function GET(req: NextRequest) {
  try {
    return NextResponse.redirect(buildAuthUrl(req.nextUrl.origin));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    // Bounce back to settings with the error so the user sees why it failed.
    const url = new URL('/settings', req.nextUrl.origin);
    url.searchParams.set('drive_error', message);
    return NextResponse.redirect(url);
  }
}
