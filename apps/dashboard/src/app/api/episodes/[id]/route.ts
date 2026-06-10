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
