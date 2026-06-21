'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  Channel,
  DriveAuthStatus,
  DriveFolderOption,
  IntroPreset,
  TrelloBoardOption,
  TrelloListOption,
} from '@slate/shared';
import { Shell, PageHeader } from '@/components/Shell';
import { Select, Toggle, ConfirmDialog, type ConfirmConfig } from '@/components/ui';

interface FormState {
  id: string | null; // null = creating
  name: string;
  trello_board_id: string;
  trello_source_list_id: string;
  trello_resolve_list_id: string;
  drive_folder_id: string;
  enabled: boolean;
  video_mode: boolean;
  edit_intro_only: boolean;
  intro_preset_id: string; // '' = none
}

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  trello_board_id: '',
  trello_source_list_id: '',
  trello_resolve_list_id: '',
  drive_folder_id: '',
  enabled: true,
  video_mode: false,
  edit_intro_only: false,
  intro_preset_id: '',
};

export default function SettingsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [boards, setBoards] = useState<TrelloBoardOption[]>([]);
  const [lists, setLists] = useState<TrelloListOption[]>([]);
  const [driveStatus, setDriveStatus] = useState<DriveAuthStatus | null>(null);
  const [folders, setFolders] = useState<DriveFolderOption[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [presets, setPresets] = useState<IntroPreset[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [listsLoading, setListsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmConfig | null>(null);

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

  const loadPresets = useCallback(async () => {
    try {
      const res = await fetch('/api/intro-presets', { cache: 'no-store' });
      if (res.ok) setPresets((await res.json()) as IntroPreset[]);
    } catch {
      /* presets are optional; ignore load failures */
    }
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

  const loadDriveStatus = useCallback(async (): Promise<DriveAuthStatus> => {
    const res = await fetch('/api/drive/status', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Failed to load Drive status');
    setDriveStatus(data as DriveAuthStatus);
    return data as DriveAuthStatus;
  }, []);

  const loadFolders = useCallback(async () => {
    setFoldersLoading(true);
    try {
      const res = await fetch('/api/drive/folders');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load Drive folders');
      setFolders(data as DriveFolderOption[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load Drive folders');
    } finally {
      setFoldersLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [, , status] = await Promise.all([
          loadChannels(),
          loadBoards(),
          loadDriveStatus(),
          loadPresets(),
        ]);
        if (status.connected) void loadFolders();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [loadChannels, loadBoards, loadDriveStatus, loadFolders, loadPresets]);

  // Surface the result of the Google connect redirect (?drive=connected /
  // ?drive_error=…) once, then clean the URL.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams(window.location.search);
    const connected = p.get('drive') === 'connected';
    const driveError = p.get('drive_error');
    if (connected) {
      setNotice('Google Drive connected.');
      void loadDriveStatus().then((s) => {
        if (s.connected) void loadFolders();
      });
    }
    if (driveError) setError(driveError);
    if (connected || driveError) window.history.replaceState({}, '', '/settings');
  }, [loadDriveStatus, loadFolders]);

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
      video_mode: ch.video_mode ?? false,
      edit_intro_only: ch.edit_intro_only ?? false,
      intro_preset_id: ch.intro_preset_id ?? '',
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
        video_mode: form.video_mode,
        edit_intro_only: form.edit_intro_only,
        intro_preset_id: form.intro_preset_id || null,
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

  function remove(id: string, name: string) {
    setConfirm({
      title: `Delete channel “${name}”?`,
      message: 'The watcher will stop polling it. Episodes already processed are unaffected.',
      confirmLabel: 'Delete channel',
      danger: true,
      onConfirm: async () => {
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
      },
    });
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

      {/* ── Google Drive connection ── */}
      <GoogleDriveCard status={driveStatus} loading={loading} />

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
            <Select
              value={form.trello_board_id}
              onChange={onBoardChange}
              options={boards.map((b) => ({ value: b.id, label: b.name }))}
              placeholder="Select a board…"
              emptyLabel="No boards found"
            />
          </Field>

          <Field label="Source list">
            <Select
              value={form.trello_source_list_id}
              onChange={(v) => setForm({ ...form, trello_source_list_id: v })}
              options={lists.map((l) => ({ value: l.id, label: l.name }))}
              disabled={!form.trello_board_id || listsLoading}
              placeholder={
                !form.trello_board_id
                  ? 'Select a board first…'
                  : listsLoading
                    ? 'Loading lists…'
                    : 'Select a list…'
              }
            />
          </Field>

          <Field label="Resolve list (cards move here when done)">
            <Select
              value={form.trello_resolve_list_id}
              onChange={(v) => setForm({ ...form, trello_resolve_list_id: v })}
              options={lists.map((l) => ({ value: l.id, label: l.name }))}
              disabled={!form.trello_board_id || listsLoading}
              placeholder={
                !form.trello_board_id
                  ? 'Select a board first…'
                  : listsLoading
                    ? 'Loading lists…'
                    : 'Select a list…'
              }
            />
          </Field>

          <Field label="Google Drive folder">
            {/* Paste a folder ID directly… */}
            <input
              value={form.drive_folder_id}
              onChange={(e) => setForm({ ...form, drive_folder_id: e.target.value })}
              placeholder="Paste a folder ID — or pick from your account below"
              className={inputCls}
            />
            {/* …or pick one from the connected account (fills the field above). */}
            {driveStatus?.connected && (
              <div className="mt-2">
                <Select
                  value={folders.some((f) => f.id === form.drive_folder_id) ? form.drive_folder_id : ''}
                  onChange={(v) => v && setForm({ ...form, drive_folder_id: v })}
                  options={folders.map((f) => ({ value: f.id, label: f.name }))}
                  disabled={foldersLoading}
                  placeholder={foldersLoading ? 'Loading folders…' : 'Or pick a folder…'}
                  emptyLabel="No folders found"
                />
              </div>
            )}
            {!driveStatus?.connected && (
              <p className="mt-1.5 text-[11px] text-ghost">
                Connect a Google account above to pick from a list, or just paste a folder ID.
              </p>
            )}
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

          <Field label="Output mode">
            <div className="flex items-center gap-3 pt-1.5">
              <Toggle
                checked={form.video_mode}
                onChange={(v) =>
                  setForm({ ...form, video_mode: v, edit_intro_only: v ? form.edit_intro_only : false })
                }
              />
              <span className="text-sm font-medium text-ink">
                {form.video_mode ? 'Build video' : 'Build episode package'}
              </span>
            </div>
            <p className="mt-1.5 text-[11px] text-ghost">
              {form.video_mode
                ? 'Renders & uploads a finished MP4.'
                : 'Uploads the generated asset bundle (default).'}
            </p>
          </Field>

          {form.video_mode && (
            <Field label="Intro only">
              <div className="flex items-center gap-3 pt-1.5">
                <Toggle
                  checked={form.edit_intro_only}
                  onChange={(v) => setForm({ ...form, edit_intro_only: v })}
                />
                <span className="text-sm font-medium text-ink">
                  {form.edit_intro_only ? 'Edit the intro only' : 'Build the full video'}
                </span>
              </div>
              <p className="mt-1.5 text-[11px] text-ghost">
                {form.edit_intro_only
                  ? 'Skips episode generation — only the edited intro is rendered & uploaded to Drive.'
                  : 'Generates the full episode and stitches the intro.'}
              </p>
            </Field>
          )}

          {form.video_mode && (
            <Field label="Intro preset">
              <Select
                value={form.intro_preset_id}
                onChange={(v) => setForm({ ...form, intro_preset_id: v })}
                options={[
                  { value: '', label: 'Default (no preset)' },
                  ...presets.map((p) => ({ value: p.id, label: p.channel ? `${p.channel} · ${p.name}` : p.name })),
                ]}
                placeholder="Default (no preset)"
                emptyLabel="No presets saved yet"
              />
            </Field>
          )}
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
                    {ch.video_mode && (
                      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                        video
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

      <ConfirmDialog config={confirm} onClose={() => setConfirm(null)} />
    </Shell>
  );
}

/**
 * Google Drive connection panel. Uploads run as the connected account; the
 * Connect button is a full-page navigation to /api/drive/connect (which
 * redirects to Google's consent screen). Reconnecting switches the account for
 * every channel at once.
 */
function GoogleDriveCard({ status, loading }: { status: DriveAuthStatus | null; loading: boolean }) {
  const connected = status?.connected ?? false;
  return (
    <section className="mb-8 rounded-3xl border border-hair bg-card p-6 shadow-card">
      <h2 className="mb-1 text-sm font-semibold text-ink">Google Drive</h2>
      <p className="mb-4 text-[12px] text-muted">
        Episodes upload to this account. All channels share it — reconnecting
        switches the account everywhere.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <span
            className={`h-2 w-2 rounded-full ${
              connected ? 'bg-emerald-500' : status === null && !loading ? 'bg-amber-400' : 'bg-ghost'
            }`}
          />
          {loading ? (
            <span className="text-muted">Checking…</span>
          ) : status === null ? (
            // The status check itself failed — don't claim "not connected".
            <span className="text-muted">Couldn’t check connection (is the server running / env set?)</span>
          ) : connected ? (
            <span className="text-ink">
              Connected
              {status.account_email && (
                <span className="text-muted"> · {status.account_email}</span>
              )}
            </span>
          ) : (
            <span className="text-muted">Not connected</span>
          )}
        </div>
        <a
          href="/api/drive/connect"
          className="inline-flex items-center rounded-lg border border-hair bg-card px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-brand/40 hover:text-brand"
        >
          {connected ? 'Reconnect / switch account' : 'Connect Google Drive'}
        </a>
      </div>
    </section>
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
