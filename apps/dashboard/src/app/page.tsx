'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { Episode, EpisodeStatus, PhaseStatus, ProgressStep, TimelinePhase } from '@slate/shared';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { Shell, PageHeader } from '@/components/Shell';
import { ConfirmDialog, type ConfirmConfig } from '@/components/ui';

const REFRESH_MS = 30_000;

type Filter = 'all' | EpisodeStatus;

export default function Page() {
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const [errorEp, setErrorEp] = useState<Episode | null>(null);
  const [confirm, setConfirm] = useState<ConfirmConfig | null>(null);

  const load = useCallback(async (manual = false) => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    if (manual) setRefreshing(true);
    const { data, error } = await supabase
      .from('episodes')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      setError(error.message);
    } else {
      setEpisodes((data ?? []) as Episode[]);
      setError(null);
      setLastUpdated(new Date());
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const stop = useCallback(
    async (ep: Episode) => {
      setStopping((s) => new Set(s).add(ep.id));
      setEpisodes((list) => list.map((e) => (e.id === ep.id ? { ...e, stage: 'Stopping…' } : e)));
      try {
        const res = await fetch(`/api/episodes/${ep.id}/cancel`, { method: 'POST' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? 'Failed to stop');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to stop');
      } finally {
        setTimeout(() => {
          setStopping((s) => {
            const n = new Set(s);
            n.delete(ep.id);
            return n;
          });
          load();
        }, 6000);
      }
    },
    [load],
  );

  const confirmStop = useCallback(
    (ep: Episode) => {
      setConfirm({
        title: `Stop “${ep.card_title}”?`,
        message: 'The watcher cancels this run within ~10 seconds. You can retry it afterward.',
        confirmLabel: 'Stop episode',
        danger: true,
        onConfirm: () => stop(ep),
      });
    },
    [stop],
  );

  const removeEpisode = useCallback(
    (ep: Episode, mode: 'delete' | 'retry') => {
      setConfirm({
        title: mode === 'retry' ? `Retry “${ep.card_title}”?` : `Delete “${ep.card_title}”?`,
        message:
          mode === 'retry'
            ? 'The record is reset to queued and the card is reprocessed — it must still be in the source list.'
            : 'This permanently removes the episode record from the dashboard.',
        confirmLabel: mode === 'retry' ? 'Retry' : 'Delete',
        danger: mode === 'delete',
        onConfirm: async () => {
          try {
            const res = await fetch(`/api/episodes/${ep.id}`, {
              method: mode === 'retry' ? 'PATCH' : 'DELETE',
            });
            if (!res.ok) {
              const d = await res.json().catch(() => ({}));
              throw new Error(d.error ?? 'Failed');
            }
            if (mode === 'retry') {
              // Keep the row — flip it to queued; the watcher re-picks it in place.
              setEpisodes((list) =>
                list.map((e) =>
                  e.id === ep.id
                    ? { ...e, status: 'queued', stage: 'Queued', error_message: null, drive_folder_url: null }
                    : e,
                ),
              );
            } else {
              setEpisodes((list) => list.filter((e) => e.id !== ep.id));
            }
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed');
          }
        },
      });
    },
    [],
  );

  const counts = useMemo(
    () => ({
      total: episodes.length,
      processing: episodes.filter((e) => e.status === 'processing').length,
      done: episodes.filter((e) => e.status === 'done').length,
      failed: episodes.filter((e) => e.status === 'failed').length,
      cancelled: episodes.filter((e) => e.status === 'cancelled').length,
    }),
    [episodes],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return episodes.filter((e) => {
      const matchesStatus = filter === 'all' || e.status === filter;
      const matchesQuery =
        !q ||
        e.card_title.toLowerCase().includes(q) ||
        e.episode_name.toLowerCase().includes(q);
      return matchesStatus && matchesQuery;
    });
  }, [episodes, filter, query]);

  return (
    <Shell active="dashboard">
      <main className="mx-auto max-w-7xl px-6 py-8">
        <PageHeader
          title="Dashboard"
          subtitle="Live status of every episode in the pipeline"
          actions={
            <>
              <SearchBox query={query} onQuery={setQuery} />
              <LivePill configured={isSupabaseConfigured} lastUpdated={lastUpdated} />
              <button
                onClick={() => load(true)}
                disabled={!isSupabaseConfigured || refreshing}
                className="inline-flex items-center gap-2 rounded-full border border-hair bg-card px-4 py-2.5 text-sm font-medium text-ink shadow-sm transition-colors hover:border-brand/40 hover:text-brand disabled:cursor-not-allowed disabled:opacity-50"
              >
                <IconRefresh spinning={refreshing} />
                Refresh
              </button>
            </>
          }
        />

        {!isSupabaseConfigured && <ConfigNotice />}

        {error && (
          <div className="mb-6 animate-fade-in rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        )}

        <section className="mb-6 grid grid-cols-2 gap-5 lg:grid-cols-4">
          <StatCard
            label="Total episodes"
            value={counts.total}
            tone="neutral"
            icon={<IconStack />}
            active={filter === 'all'}
            onClick={() => setFilter('all')}
          />
          <StatCard
            label="Processing"
            value={counts.processing}
            tone="processing"
            icon={<IconSpinner />}
            active={filter === 'processing'}
            onClick={() => setFilter('processing')}
          />
          <StatCard
            label="Done"
            value={counts.done}
            tone="done"
            icon={<IconCheck />}
            active={filter === 'done'}
            onClick={() => setFilter('done')}
          />
          <StatCard
            label="Failed"
            value={counts.failed}
            tone="failed"
            icon={<IconAlert />}
            active={filter === 'failed'}
            onClick={() => setFilter('failed')}
          />
        </section>

        <div className="overflow-hidden rounded-3xl border border-hair bg-card shadow-card">
          <div className="flex flex-col gap-4 border-b border-hair px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-baseline gap-2">
              <h2 className="text-base font-bold text-ink">Episodes</h2>
              <span className="text-xs text-ghost">{visible.length} shown</span>
            </div>
            <FilterTabs filter={filter} onFilter={setFilter} counts={counts} />
          </div>

          <div className="divide-y divide-hairsoft">
            {loading && episodes.length === 0 ? (
              <SkeletonRows />
            ) : visible.length === 0 ? (
              <EmptyRow
                text={
                  episodes.length === 0
                    ? 'No episodes yet. Add a card to a channel’s source list to get started.'
                    : 'No episodes match your filters.'
                }
              />
            ) : (
              visible.map((ep) => (
                <Row
                  key={ep.id}
                  ep={ep}
                  onStop={confirmStop}
                  stopping={stopping.has(ep.id)}
                  onRemove={removeEpisode}
                  onShowError={setErrorEp}
                />
              ))
            )}
          </div>
        </div>

        <footer className="mt-6 text-center text-xs text-ghost">
          Slate · Bodycam Horror Studio pipeline
        </footer>
      </main>

      {errorEp && <ErrorModal ep={errorEp} onClose={() => setErrorEp(null)} />}
      <ConfirmDialog config={confirm} onClose={() => setConfirm(null)} />
    </Shell>
  );
}

/* ─────────────────────────── Error modal ─────────────────────────── */

function ErrorModal({ ep, onClose }: { ep: Episode; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ep.error_message ?? '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={onClose} />
      <div className="animate-fade-in relative z-10 flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-hair bg-card shadow-soft">
        <div className="flex items-start justify-between gap-4 border-b border-hair px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-lg bg-rose-50 text-rose-600">
                <IconAlert />
              </span>
              <span className="text-sm font-semibold text-ink">Error details</span>
            </div>
            <div className="mt-1 truncate text-[12px] text-muted">{ep.card_title}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={copy}
              className="rounded-lg border border-hair bg-card px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              className="grid h-7 w-7 place-items-center rounded-lg border border-hair bg-card text-muted transition-colors hover:text-ink"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
        <pre className="overflow-auto whitespace-pre-wrap break-words px-6 py-4 font-mono text-[12px] leading-relaxed text-ink/80">
          {ep.error_message}
        </pre>
      </div>
    </div>
  );
}

/* ─────────────────────────── Live pill ─────────────────────────── */

function LivePill({ configured, lastUpdated }: { configured: boolean; lastUpdated: Date | null }) {
  return (
    <div className="hidden items-center gap-2 rounded-full border border-hair bg-card px-3 py-1.5 text-xs text-muted shadow-sm sm:flex">
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          configured ? 'animate-pulse-soft bg-brand' : 'bg-ghost'
        }`}
      />
      {configured ? (
        <span>
          Live
          {lastUpdated && <span className="text-ghost"> · {lastUpdated.toLocaleTimeString()}</span>}
        </span>
      ) : (
        <span>Offline</span>
      )}
    </div>
  );
}

/* ─────────────────────────── Stat cards ─────────────────────────── */

type Tone = 'neutral' | 'processing' | 'done' | 'failed';

function StatCard({
  label,
  value,
  tone,
  icon,
  active,
  onClick,
}: {
  label: string;
  value: number;
  tone: Tone;
  icon: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  const t: Record<Tone, { value: string; icon: string; ring: string }> = {
    neutral: { value: 'text-ink', icon: 'text-navy bg-navy-soft', ring: 'hover:border-navy/20' },
    processing: { value: 'text-brand', icon: 'text-brand bg-brand-soft', ring: 'hover:border-brand/30' },
    done: { value: 'text-emerald-600', icon: 'text-emerald-600 bg-emerald-50', ring: 'hover:border-emerald-200' },
    failed: { value: 'text-rose-600', icon: 'text-rose-600 bg-rose-50', ring: 'hover:border-rose-200' },
  };
  const c = t[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={`Filter: ${label}`}
      className={`group relative w-full overflow-hidden rounded-3xl border bg-card p-6 text-left shadow-card transition-all hover:shadow-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
        active ? 'border-navy/40 ring-2 ring-navy/15' : `border-hair ${c.ring}`
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold uppercase tracking-wider text-ghost">{label}</span>
        <span className={`grid h-10 w-10 place-items-center rounded-2xl ${c.icon}`}>{icon}</span>
      </div>
      <div className={`mt-5 text-[40px] font-bold leading-none tabular-nums tracking-tight ${c.value}`}>
        {value}
      </div>
    </button>
  );
}

/* ─────────────────────────── Toolbar bits ─────────────────────────── */

function FilterTabs({
  filter,
  onFilter,
  counts,
}: {
  filter: Filter;
  onFilter: (f: Filter) => void;
  counts: { total: number; processing: number; done: number; failed: number; cancelled: number };
}) {
  const tabs: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: counts.total },
    { key: 'processing', label: 'Processing', count: counts.processing },
    { key: 'done', label: 'Done', count: counts.done },
    { key: 'failed', label: 'Failed', count: counts.failed },
    { key: 'cancelled', label: 'Cancelled', count: counts.cancelled },
  ];
  return (
    <div className="inline-flex flex-wrap gap-1">
      {tabs.map((tab) => {
        const active = filter === tab.key;
        return (
          <button
            key={tab.key}
            onClick={() => onFilter(tab.key)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
              active ? 'bg-navy text-white' : 'text-muted hover:bg-sunken hover:text-ink'
            }`}
          >
            {tab.label}
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                active ? 'bg-white/25 text-white' : 'bg-sunken text-ghost'
              }`}
            >
              {tab.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SearchBox({ query, onQuery }: { query: string; onQuery: (q: string) => void }) {
  return (
    <div className="relative w-full sm:w-72">
      <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ghost">
        <IconSearch />
      </span>
      <input
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Search title or episode…"
        className="w-full rounded-full border border-hair bg-card py-2.5 pl-10 pr-4 text-sm text-ink placeholder:text-ghost shadow-sm outline-none transition-colors focus:border-brand/40 focus:ring-2 focus:ring-brand/10"
      />
    </div>
  );
}

/* ─────────────────────────── Episode list ─────────────────────────── */

/**
 * Test-edit control for a completed episode: pick a duration and request a real-look
 * test render. The watcher builds the first N seconds of the body and drops the MP4
 * into the episode's Drive folder. Reflects test_edit_status as it progresses.
 */
const TEST_EDIT_STAGES = ['Downloading bundle', 'Editing intro', 'Rendering body', 'Stitching intro', 'Uploading to Drive'];

/** Live stage progress for an in-flight test edit — shown under the title (like the pipeline's). */
function TestEditProgress({ ep }: { ep: Episode }) {
  const stage = ep.test_edit_stage ?? '';
  const curIdx = TEST_EDIT_STAGES.findIndex((s) => stage.startsWith(s));
  return (
    <div className="mt-1.5 flex items-center gap-2 text-[12px] text-muted">
      <span className="font-medium text-brand-dim">Test edit</span>
      <span className="flex items-center gap-1">
        {TEST_EDIT_STAGES.map((s, i) => (
          <span
            key={s}
            title={s}
            className={`h-1.5 w-1.5 rounded-full transition-colors ${
              i < curIdx ? 'bg-brand' : i === curIdx ? 'bg-brand animate-pulse' : 'bg-hair'
            }`}
          />
        ))}
      </span>
      <span>{stage || 'Queued'}</span>
    </div>
  );
}

function TestEdit({ ep }: { ep: Episode }) {
  const [secs, setSecs] = useState(180);
  const [busy, setBusy] = useState(false);
  const status = ep.test_edit_status;
  const inFlight = busy || status === 'queued' || status === 'processing';
  const label =
    status === 'processing' ? 'Building…' : status === 'queued' || busy ? 'Queued…' : 'Test edit';

  const go = async () => {
    setBusy(true);
    try {
      await fetch(`/api/episodes/${ep.id}/test-edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: secs }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inline-flex items-center gap-1.5">
      <select
        value={secs}
        onChange={(e) => setSecs(Number(e.target.value))}
        disabled={inFlight}
        title="Test edit length"
        className="rounded-lg border border-hair bg-card px-2 py-1.5 text-xs text-muted disabled:opacity-50"
      >
        {[180, 300, 600, 900, 1800].map((s) => (
          <option key={s} value={s}>
            {s / 60} min
          </option>
        ))}
      </select>
      <button
        onClick={go}
        disabled={inFlight}
        title="Build a real-look test edit of the first N seconds and upload it to the episode's Drive folder"
        className="inline-flex min-w-[5.5rem] items-center justify-center gap-1.5 rounded-lg border border-brand/30 bg-brand-soft px-2.5 py-1.5 text-xs font-medium text-brand-dim transition-colors hover:bg-brand/10 disabled:opacity-50"
      >
        {label}
      </button>
      {/* Fixed-width result slot so the trash button lines up across every row. */}
      <span className="w-16 text-right text-xs font-medium">
        {status === 'done' && ep.test_edit_url ? (
          <a
            href={ep.test_edit_url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open the test edit's Drive folder"
            className="text-emerald-600 hover:text-emerald-700"
          >
            ✓ ready
          </a>
        ) : status === 'failed' ? (
          <span className="text-rose-600">failed</span>
        ) : null}
      </span>
    </div>
  );
}

function Row({
  ep,
  onStop,
  stopping,
  onRemove,
  onShowError,
}: {
  ep: Episode;
  onStop: (ep: Episode) => void;
  stopping: boolean;
  onRemove: (ep: Episode, mode: 'delete' | 'retry') => void;
  onShowError: (ep: Episode) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasTimeline = (ep.timeline?.length ?? 0) > 0;
  const isProcessing = ep.status === 'processing';
  return (
    <div className="transition-colors hover:bg-sunken/40">
      <div className="flex items-center gap-4 px-5 py-4">
        {hasTimeline ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            title={open ? 'Hide pipeline' : 'Show pipeline'}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ghost transition-colors hover:bg-sunken hover:text-ink"
          >
            <IconChevron open={open} />
          </button>
        ) : (
          <span className="h-7 w-7 shrink-0" />
        )}

        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-ink">{ep.card_title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ghost">
            <span className="font-mono">{ep.episode_name}</span>
            {ep.channel_name && (
              <>
                <Dot />
                <span className="rounded-md border border-hair bg-sunken px-1.5 py-0.5 font-medium text-muted">
                  {ep.channel_name}
                </span>
              </>
            )}
            <Dot />
            <TimeMeta created={ep.created_at} completed={ep.completed_at} />
          </div>
          {isProcessing && (ep.stage || (ep.progress?.length ?? 0) > 0) && (
            <StageProgress stage={ep.stage} steps={ep.progress ?? []} />
          )}
          {(ep.test_edit_status === 'processing' || ep.test_edit_status === 'queued') && <TestEditProgress ep={ep} />}
          {ep.error_message && (
            <button
              type="button"
              onClick={() => onShowError(ep)}
              title="View full error"
              className="mt-1.5 block max-w-full truncate text-left text-[12px] text-rose-600 underline decoration-rose-300 decoration-dotted underline-offset-2 hover:text-rose-700"
            >
              {ep.error_message.split('\n')[0]}
            </button>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          <StatusBadge status={ep.status} />
          {ep.drive_folder_url && (
            <a
              href={ep.drive_folder_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-hair bg-card px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand"
            >
              Open
              <IconExternal />
            </a>
          )}
          {isProcessing ? (
            <button
              onClick={() => onStop(ep)}
              disabled={stopping}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-medium text-rose-700 transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <IconStop />
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <>
              {ep.status === 'done' && <TestEdit ep={ep} />}
              {(ep.status === 'failed' || ep.status === 'cancelled') && (
                <button
                  onClick={() => onRemove(ep, 'retry')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-brand/30 bg-brand-soft px-2.5 py-1.5 text-xs font-medium text-brand-dim transition-colors hover:bg-brand/10"
                >
                  <IconRetry />
                  Retry
                </button>
              )}
              <button
                onClick={() => onRemove(ep, 'delete')}
                title="Delete record"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-hair bg-card text-muted transition-colors hover:border-rose-200 hover:text-rose-600"
              >
                <IconTrash />
              </button>
            </>
          )}
        </div>
      </div>

      {open && hasTimeline && (
        <div className="border-t border-hairsoft bg-sunken/30 px-5 pb-7 pt-4">
          <EpisodeStepper timeline={ep.timeline ?? []} />
        </div>
      )}
    </div>
  );
}

function Dot() {
  return <span aria-hidden className="text-ghost/60">·</span>;
}

function TimeMeta({ created, completed }: { created: string | null; completed: string | null }) {
  const c = created ? new Date(created) : null;
  if (!c || isNaN(c.getTime())) return <span className="text-ghost">—</span>;
  const dateStr = c.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const ctime = c.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  let tail = '';
  const d = completed ? new Date(completed) : null;
  if (d && !isNaN(d.getTime())) {
    const sameDay = d.toDateString() === c.toDateString();
    const dtime = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    tail = sameDay
      ? ` → ${dtime}`
      : ` → ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${dtime}`;
  }
  return (
    <span title={relativeTime(c)} className="whitespace-nowrap">
      {dateStr}, {ctime}
      {tail}
    </span>
  );
}

/**
 * Compact live status for a processing row: the current phase + its parallel
 * sub-task bars (Script / Images / Voiceover). The full phase timeline lives in
 * the expandable stepper (chevron), so this stays small and never widens the row.
 */
function StageProgress({ stage, steps }: { stage: string | null; steps: ProgressStep[] }) {
  return (
    <div className="mt-2 w-[224px] max-w-full space-y-2">
      {stage && (
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full bg-brand" />
          <span className="truncate" title={stage}>
            {stage}
          </span>
        </div>
      )}
      {steps.length > 0 ? (
        <div className="space-y-2">
          {steps.map((s) => (
            <StepRow key={s.label} step={s} />
          ))}
        </div>
      ) : (
        <IndeterminateBar />
      )}
    </div>
  );
}

/* ─────────────────────────── Episode stepper (expanded) ─────────────────────────── */

const PHASE_STATUS_TEXT: Record<PhaseStatus, string> = {
  done: 'Completed',
  active: 'In Progress',
  pending: 'Pending',
  failed: 'Failed',
};

/**
 * Horizontal stepper for an episode's full pipeline — works during and after the
 * run (timeline is persisted). The generation phase shows its parallel sub-tasks
 * (Script / Images / Voiceover) with what each achieved.
 */
function EpisodeStepper({ timeline }: { timeline: TimelinePhase[] }) {
  return (
    <div className="rounded-2xl border border-hair bg-card p-6 shadow-sm">
      <div className="mb-5 text-[11px] font-semibold uppercase tracking-wider text-ghost">
        Pipeline
      </div>
      <div className="no-scrollbar flex items-start overflow-x-auto pb-1">
        {timeline.map((ph, i) => (
          <Fragment key={ph.key}>
            <PhaseColumn phase={ph} index={i} />
            {i < timeline.length - 1 && (
              <div
                className={`mt-[15px] h-[3px] min-w-[16px] flex-1 rounded-full ${
                  ph.status === 'done' ? 'bg-emerald-400' : 'bg-hair'
                }`}
              />
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function PhaseColumn({ phase, index }: { phase: TimelinePhase; index: number }) {
  const statusColor =
    phase.status === 'done'
      ? 'text-emerald-600'
      : phase.status === 'active'
        ? 'text-brand-dim'
        : phase.status === 'failed'
          ? 'text-rose-600'
          : 'text-ghost';
  return (
    <div className="flex w-[140px] shrink-0 flex-col items-center px-1.5 text-center">
      <StepNodeCircle status={phase.status} />
      <div className="mt-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-ghost">
        Step {index + 1}
      </div>
      <div className="mt-0.5 text-[13px] font-semibold leading-snug text-ink">{phase.label}</div>
      <div className={`mt-0.5 text-[11px] font-medium ${statusColor}`}>
        {PHASE_STATUS_TEXT[phase.status]}
      </div>
      {phase.steps && phase.steps.length > 0 && (
        <div className="mt-3 w-full space-y-1 rounded-xl border border-hair bg-sunken/60 p-2.5">
          {phase.steps.map((s) => (
            <SubStepNode key={s.label} step={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function StepNodeCircle({ status }: { status: PhaseStatus }) {
  if (status === 'done') {
    return (
      <span className="grid h-8 w-8 place-items-center rounded-full bg-emerald-500 text-white shadow-sm ring-4 ring-emerald-500/10">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="m5 12.5 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (status === 'active') {
    return (
      <span className="grid h-8 w-8 place-items-center rounded-full border-[3px] border-brand bg-card shadow-sm ring-4 ring-brand/10">
        <span className="h-2.5 w-2.5 animate-pulse-soft rounded-full bg-brand" />
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="grid h-8 w-8 place-items-center rounded-full bg-rose-500 text-white shadow-sm ring-4 ring-rose-500/10">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return <span className="h-8 w-8 rounded-full border-2 border-hair bg-card" />;
}

function SubStepNode({ step }: { step: ProgressStep }) {
  const pct = parseProgress(step.text);
  const done = isStepDone(step.text) || pct === 100;
  const metric = shortMetric(step.text);
  return (
    <div className="flex items-center gap-2" title={step.text}>
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          done ? 'bg-emerald-500' : 'animate-pulse-soft bg-brand'
        }`}
      />
      <span className="flex-1 truncate text-left text-[11px] font-medium text-ink/75">
        {step.label}
      </span>
      <span
        className={`shrink-0 text-[10px] font-medium tabular-nums ${
          done ? 'text-emerald-600' : 'text-ghost'
        }`}
      >
        {done ? '✓' : metric || '…'}
      </span>
    </div>
  );
}

/**
 * One sub-task row with a clear state:
 *  - done       → full green bar + ✓
 *  - counting   → blue bar at X/Y, with "9/16 · 56%"
 *  - working    → animated indeterminate bar (no number reported yet)
 */
function StepRow({ step }: { step: ProgressStep }) {
  const pct = parseProgress(step.text);
  const ratio = shortMetric(step.text); // "9/16" or "56%" or ''
  const done = isStepDone(step.text) || pct === 100;
  const indeterminate = !done && pct === null;
  const width = done ? 100 : (pct ?? 0);

  const right = done
    ? 'Done'
    : indeterminate
      ? 'working…'
      : ratio && ratio.includes('/') && pct !== null
        ? `${ratio} · ${pct}%`
        : `${pct ?? 0}%`;

  return (
    <div title={step.text}>
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
        <span className="font-semibold text-ink/80">{step.label}</span>
        <span
          className={`tabular-nums ${done ? 'font-medium text-emerald-600' : 'text-muted'}`}
        >
          {done && '✓ '}
          {right}
        </span>
      </div>
      {indeterminate ? (
        <IndeterminateBar />
      ) : (
        <div className="h-2 overflow-hidden rounded-full bg-sunken">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              done ? 'bg-emerald-500' : 'bg-brand'
            }`}
            style={{ width: `${width}%` }}
          />
        </div>
      )}
    </div>
  );
}

/** A genuinely-animated indeterminate bar (segment sliding across the track). */
function IndeterminateBar() {
  return (
    <div className="relative h-2 overflow-hidden rounded-full bg-sunken">
      <div className="absolute inset-y-0 left-0 w-1/3 animate-indeterminate rounded-full bg-brand/70" />
    </div>
  );
}

function StatusBadge({ status }: { status: EpisodeStatus }) {
  const map: Record<EpisodeStatus, { label: string; cls: string; dot: string; pulse?: boolean }> = {
    queued: {
      label: 'Queued',
      cls: 'border-amber-200 bg-amber-50 text-amber-700',
      dot: 'bg-amber-500',
      pulse: true,
    },
    processing: {
      label: 'Processing',
      cls: 'border-brand/20 bg-brand-soft text-brand-dim',
      dot: 'bg-brand',
      pulse: true,
    },
    done: { label: 'Done', cls: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
    failed: { label: 'Failed', cls: 'border-rose-200 bg-rose-50 text-rose-700', dot: 'bg-rose-500' },
    cancelled: { label: 'Cancelled', cls: 'border-hair bg-sunken text-muted', dot: 'bg-ghost' },
  };
  const s = map[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${s.cls} ${
        s.pulse ? 'animate-pulse-soft' : ''
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="px-6 py-16 text-center">
      <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl border border-hair bg-sunken text-ghost">
        <IconInbox />
      </div>
      <p className="text-sm text-muted">{text}</p>
    </div>
  );
}

function Shimmer({ className = '' }: { className?: string }) {
  return (
    <div className={`relative overflow-hidden rounded-md bg-sunken ${className}`}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/70 to-transparent" />
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <span className="h-7 w-7 shrink-0" />
          <div className="min-w-0 flex-1 space-y-2">
            <Shimmer className="h-3.5 w-56" />
            <Shimmer className="h-3 w-72" />
          </div>
          <Shimmer className="h-6 w-24 shrink-0" />
        </div>
      ))}
    </>
  );
}

/* ─────────────────────────── Config notice ─────────────────────────── */

function ConfigNotice() {
  return (
    <div className="mb-6 animate-fade-in rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <span className="font-semibold">Supabase not configured.</span> Add{' '}
      <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs text-amber-900">
        NEXT_PUBLIC_SUPABASE_URL
      </code>{' '}
      and{' '}
      <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs text-amber-900">
        NEXT_PUBLIC_SUPABASE_ANON_KEY
      </code>{' '}
      to{' '}
      <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs text-amber-900">
        apps/dashboard/.env.local
      </code>{' '}
      and restart the dev server.
    </div>
  );
}

/* ─────────────────────────── Helpers ─────────────────────────── */

/** Parse a 0–100 percentage from a stage string ("… 42%" or "9 of 16" / "9/16"). */
function parseProgress(stage: string): number | null {
  const pct = stage.match(/(\d{1,3})\s*%/);
  if (pct) return clampPct(parseInt(pct[1], 10));
  const ratio = stage.match(/(\d+)\s*(?:of|\/)\s*(\d+)/i);
  if (ratio) {
    const a = parseInt(ratio[1], 10);
    const b = parseInt(ratio[2], 10);
    if (b > 0) return clampPct(Math.round((a / b) * 100));
  }
  return null;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/** Whether a step's status text indicates it has finished. */
function isStepDone(text: string): boolean {
  return /(?:✓|✅|\bdone\b|\bready\b|\bcomplete\w*\b|\bfinished\b|100\s*%)/i.test(text);
}

/** A compact metric from a status string: "9/16", "43%", or '' if none. */
function shortMetric(text: string): string {
  const ratio = text.match(/(\d+)\s*(?:of|\/)\s*(\d+)/i);
  if (ratio) return `${ratio[1]}/${ratio[2]}`;
  const pct = text.match(/(\d{1,3})\s*%/);
  if (pct) return `${pct[1]}%`;
  return '';
}

function relativeTime(d: Date): string {
  const diff = Date.now() - d.getTime();
  const sec = Math.round(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ─────────────────────────── Icons ─────────────────────────── */

function IconStack() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="m12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
function IconSpinner() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3a9 9 0 1 0 9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="m5 12.5 4.5 4.5L19 7" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconAlert() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 8v5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="12" cy="16.5" r="0.4" fill="currentColor" stroke="currentColor" strokeWidth="1.2" />
      <path d="M10.3 4.3 2.7 17.5A2 2 0 0 0 4.4 20.5h15.2a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}
function IconRefresh({ spinning }: { spinning?: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden className={spinning ? 'animate-spin' : ''}>
      <path d="M20 11a8 8 0 1 0-.6 4M20 5v6h-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={`mt-0.5 shrink-0 text-ghost transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconStop() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}
function IconRetry() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M20 11a8 8 0 1 0-.6 4M20 5v6h-6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconTrash() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7m4 4v6m6-6v6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconSearch() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
function IconExternal() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M14 5h5v5M19 5l-8 8M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconInbox() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 13h4l2 3h6l2-3h4M5 5h14l2 8v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4L5 5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}
