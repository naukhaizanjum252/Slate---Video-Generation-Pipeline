'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Channel, TrelloBoardOption, TrelloListOption } from '@slate/shared';
import { Shell, PageHeader } from '@/components/Shell';

interface FormState {
  id: string | null; // null = creating
  name: string;
  trello_board_id: string;
  trello_source_list_id: string;
  trello_resolve_list_id: string;
  drive_folder_id: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  trello_board_id: '',
  trello_source_list_id: '',
  trello_resolve_list_id: '',
  drive_folder_id: '',
  enabled: true,
};

export default function SettingsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [boards, setBoards] = useState<TrelloBoardOption[]>([]);
  const [lists, setLists] = useState<TrelloListOption[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [listsLoading, setListsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadChannels = useCallback(async () => {
    const res = await fetch('/api/channels');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Failed to load channels');
    setChannels(data as Channel[]);
  }, []);

  const loadBoards = useCallback(async () => {
    const res = await fetch('/api/trello/boards');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Failed to load Trello boards');
    setBoards(data as TrelloBoardOption[]);
  }, []);

  const loadLists = useCallback(async (boardId: string) => {
    if (!boardId) {
      setLists([]);
      return;
    }
    setListsLoading(true);
    try {
      const res = await fetch(`/api/trello/lists?boardId=${encodeURIComponent(boardId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load lists');
      setLists(data as TrelloListOption[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load lists');
    } finally {
      setListsLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await Promise.all([loadChannels(), loadBoards()]);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [loadChannels, loadBoards]);

  function onBoardChange(boardId: string) {
    // Changing board clears the previously selected lists.
    setForm((f) => ({
      ...f,
      trello_board_id: boardId,
      trello_source_list_id: '',
      trello_resolve_list_id: '',
    }));
    loadLists(boardId);
  }

  function startEdit(ch: Channel) {
    setForm({
      id: ch.id,
      name: ch.name,
      trello_board_id: ch.trello_board_id,
      trello_source_list_id: ch.trello_source_list_id,
      trello_resolve_list_id: ch.trello_resolve_list_id ?? '',
      drive_folder_id: ch.drive_folder_id ?? '',
      enabled: ch.enabled,
    });
    setNotice(null);
    setError(null);
    loadLists(ch.trello_board_id);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function resetForm() {
    setForm(EMPTY_FORM);
    setLists([]);
  }

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload = {
        name: form.name,
        trello_board_id: form.trello_board_id,
        trello_source_list_id: form.trello_source_list_id,
        trello_resolve_list_id: form.trello_resolve_list_id,
        drive_folder_id: form.drive_folder_id,
        enabled: form.enabled,
      };
      const res = await fetch(form.id ? `/api/channels/${form.id}` : '/api/channels', {
        method: form.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      setNotice(form.id ? 'Channel updated.' : 'Channel created.');
      resetForm();
      await loadChannels();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string, name: string) {
    if (typeof window !== 'undefined' && !window.confirm(`Delete channel "${name}"?`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/channels/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Delete failed');
      if (form.id === id) resetForm();
      await loadChannels();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  const canSave =
    !!form.name.trim() &&
    !!form.trello_board_id &&
    !!form.trello_source_list_id &&
    !!form.trello_resolve_list_id &&
    !!form.drive_folder_id.trim() &&
    !saving;

  return (
    <Shell active="settings">
      <main className="mx-auto max-w-4xl px-6 py-8">
        <PageHeader
          title="Channels"
          subtitle="Configure each channel’s Trello board, source list, and Drive folder."
        />

      {error && (
        <div className="mb-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-5 rounded-xl border border-brand/20 bg-brand-soft px-4 py-3 text-sm text-brand-dim">
          {notice}
        </div>
      )}

      {/* ── Form ── */}
      <section className="mb-8 rounded-3xl border border-hair bg-card p-6 shadow-card">
        <h2 className="mb-1 text-sm font-semibold text-ink">
          {form.id ? 'Edit channel' : 'Add a channel'}
        </h2>
        <p className="mb-5 text-[12px] text-muted">
          The watcher polls the <span className="font-medium text-ink">source list</span>. Cards
          stay put — status is shown on the dashboard, not by moving cards.
        </p>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field label="Channel name">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Bodycam Horror Studio"
              className={inputCls}
            />
          </Field>

          <Field label="Trello board">
            <select
              value={form.trello_board_id}
              onChange={(e) => onBoardChange(e.target.value)}
              className={inputCls}
            >
              <option value="">Select a board…</option>
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Source list">
            <select
              value={form.trello_source_list_id}
              onChange={(e) => setForm({ ...form, trello_source_list_id: e.target.value })}
              disabled={!form.trello_board_id || listsLoading}
              className={`${inputCls} disabled:cursor-not-allowed disabled:opacity-50`}
            >
              <option value="">
                {!form.trello_board_id ? 'Select a board first…' : 'Select a list…'}
              </option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Resolve list (cards move here when done)">
            <select
              value={form.trello_resolve_list_id}
              onChange={(e) => setForm({ ...form, trello_resolve_list_id: e.target.value })}
              disabled={!form.trello_board_id || listsLoading}
              className={`${inputCls} disabled:cursor-not-allowed disabled:opacity-50`}
            >
              <option value="">
                {!form.trello_board_id ? 'Select a board first…' : 'Select a list…'}
              </option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Google Drive folder ID">
            <input
              value={form.drive_folder_id}
              onChange={(e) => setForm({ ...form, drive_folder_id: e.target.value })}
              placeholder="Required — must be shared with the service account"
              className={inputCls}
            />
          </Field>

          <Field label="Enabled">
            <label className="inline-flex cursor-pointer items-center gap-2 pt-2 text-sm text-muted">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                className="h-4 w-4 accent-brand"
              />
              Watcher polls this channel
            </label>
          </Field>
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={save}
            disabled={!canSave}
            className="inline-flex items-center rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-dim disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving…' : form.id ? 'Update channel' : 'Create channel'}
          </button>
          {form.id && (
            <button
              onClick={resetForm}
              className="text-sm font-medium text-muted transition-colors hover:text-ink"
            >
              Cancel
            </button>
          )}
        </div>
      </section>

      {/* ── Existing channels ── */}
      <section className="rounded-3xl border border-hair bg-card shadow-card">
        <div className="border-b border-hair px-6 py-4">
          <h2 className="text-sm font-semibold text-ink">Channels</h2>
        </div>
        {loading ? (
          <p className="px-6 py-10 text-center text-sm text-muted">Loading…</p>
        ) : channels.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-muted">
            No channels yet. Add one above.
          </p>
        ) : (
          <ul className="divide-y divide-hairsoft">
            {channels.map((ch) => (
              <li key={ch.id} className="flex items-center justify-between gap-4 px-6 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink">{ch.name}</span>
                    {ch.enabled ? (
                      <span className="rounded-full border border-brand/20 bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand-dim">
                        enabled
                      </span>
                    ) : (
                      <span className="rounded-full border border-hair bg-sunken px-2 py-0.5 text-[11px] font-medium text-ghost">
                        disabled
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-ghost">
                    source {ch.trello_source_list_id} · resolve{' '}
                    {ch.trello_resolve_list_id || '(unset)'} · drive{' '}
                    {ch.drive_folder_id || '(unset)'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <button
                    onClick={() => startEdit(ch)}
                    className="text-sm font-medium text-muted transition-colors hover:text-brand"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => remove(ch.id, ch.name)}
                    className="text-sm font-medium text-muted transition-colors hover:text-rose-600"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      </main>
    </Shell>
  );
}

const inputCls =
  'w-full rounded-lg border border-hair bg-sunken px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-brand/40 focus:bg-card focus:ring-2 focus:ring-brand/10';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[12px] font-medium text-muted">{label}</label>
      {children}
    </div>
  );
}
