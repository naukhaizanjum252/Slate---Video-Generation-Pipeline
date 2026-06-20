import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/**
 * Delete an episode record. Note: if the Trello card is still in the channel's
 * SOURCE list (failed/cancelled episodes stay there), the watcher will re-pick
 * it on the next poll — which is exactly how "Retry" works. Done episodes have
 * their card in the resolve list, so deleting their record just removes it.
 */
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sb = getAdminClient();
    const { error } = await sb.from('episodes').delete().eq('id', params.id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Retry: reset the record to `queued` (clearing the prior failure/output) instead
 * of deleting it, so the dashboard row stays visible. The watcher re-picks `queued`
 * rows in place on the next poll (the card must still be in the source list).
 */
export async function PATCH(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sb = getAdminClient();
    const { error } = await sb
      .from('episodes')
      .update({
        status: 'queued',
        stage: 'Queued',
        progress: null,
        error_message: null,
        drive_folder_url: null,
        completed_at: null,
        timeline: null,
        cancel_requested: false,
      })
      .eq('id', params.id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
