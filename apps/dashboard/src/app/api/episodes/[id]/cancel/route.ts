import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/**
 * Request that an episode be stopped. Sets cancel_requested = true; the watcher
 * polls this flag, kills the running pipeline (or drops it from the queue), and
 * marks the episode 'cancelled'. Only meaningful while it's still processing.
 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sb = getAdminClient();
    const { data, error } = await sb
      .from('episodes')
      .update({ cancel_requested: true })
      .eq('id', params.id)
      .eq('status', 'processing')
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      return NextResponse.json(
        { error: 'Episode not found or no longer processing' },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
