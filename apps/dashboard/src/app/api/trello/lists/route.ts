import { NextRequest, NextResponse } from 'next/server';
import { fetchLists } from '@/lib/trelloServer';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const boardId = req.nextUrl.searchParams.get('boardId');
  if (!boardId) {
    return NextResponse.json({ error: 'boardId query param is required' }, { status: 400 });
  }
  try {
    return NextResponse.json(await fetchLists(boardId));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
