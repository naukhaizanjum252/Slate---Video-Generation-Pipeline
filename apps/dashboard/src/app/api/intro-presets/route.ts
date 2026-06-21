import { NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabaseAdmin';
import type { IntroPreset } from '@slate/shared';

export const dynamic = 'force-dynamic';

/** List saved intro-editor presets for the channel form's "Intro preset" dropdown. */
export async function GET() {
  try {
    const sb = getAdminClient();
    const { data, error } = await sb
      .from('intro_presets')
      .select('id, name, channel, params')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return NextResponse.json((data ?? []) as IntroPreset[]);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
