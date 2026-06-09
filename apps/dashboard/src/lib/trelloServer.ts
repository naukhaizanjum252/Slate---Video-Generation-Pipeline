import type { TrelloBoardOption, TrelloListOption } from '@slate/shared';

// Server-only Trello helpers. Credentials stay on the server; the browser only
// ever sees board/list names + IDs via the /api/trello/* routes.
const API = 'https://api.trello.com/1';

function creds(): { key: string; token: string } {
  const key = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!key || !token) {
    throw new Error('Missing TRELLO_API_KEY or TRELLO_TOKEN in the dashboard server env.');
  }
  return { key, token };
}

export async function fetchBoards(): Promise<TrelloBoardOption[]> {
  const { key, token } = creds();
  const url = `${API}/members/me/boards?fields=name,id&key=${key}&token=${token}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Trello boards request failed (${res.status})`);
  const data = (await res.json()) as Array<{ id: string; name: string }>;
  return data.map((b) => ({ id: b.id, name: b.name }));
}

export async function fetchLists(boardId: string): Promise<TrelloListOption[]> {
  const { key, token } = creds();
  const url = `${API}/boards/${boardId}/lists?fields=name,id&key=${key}&token=${token}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Trello lists request failed (${res.status})`);
  const data = (await res.json()) as Array<{ id: string; name: string }>;
  return data.map((l) => ({ id: l.id, name: l.name }));
}
