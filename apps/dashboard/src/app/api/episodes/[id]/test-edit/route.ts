import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/**
 * Request a test edit for a completed episode: flip `test_edit_status` to `queued`
 * with the requested duration. The watcher picks it up (Realtime), downloads the
 * episode's bundle from Drive, builds the first N seconds of the real body, and
 * uploads it back into the episode's Drive folder.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = (await req.json().catch(() => ({}))) as { seconds?: number };
    const seconds = Math.max(10, Math.min(3600, Math.round(body.seconds ?? 180)));
    const sb = getAdminClient();
    const { error } = await sb
      .from('episodes')
      .update({ test_edit_sec: seconds, test_edit_status: 'queued', test_edit_url: null, test_edit_stage: 'Queued' })
      .eq('id', params.id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, seconds });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
