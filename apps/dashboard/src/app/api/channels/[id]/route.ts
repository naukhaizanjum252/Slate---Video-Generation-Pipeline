import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabaseAdmin';
import { validateChannel } from '@/lib/channelValidate';

export const dynamic = 'force-dynamic';

/** Update a channel. */
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const result = validateChannel(body);
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  try {
    const sb = getAdminClient();
    const { data, error } = await sb
      .from('channels')
      .update(result.value)
      .eq('id', params.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Delete a channel. */
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const sb = getAdminClient();
    const { error } = await sb.from('channels').delete().eq('id', params.id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
