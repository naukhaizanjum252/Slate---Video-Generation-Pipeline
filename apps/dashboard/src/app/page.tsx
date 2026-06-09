'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Episode, EpisodeStatus, ProgressStep } from '@slate/shared';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { Shell, PageHeader } from '@/components/Shell';

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
      <main className="mx-auto max-w-6xl px-6 py-8">
        <PageHeader
          title="Dashboard"
          subtitle="Live status of every episode in the pipeline"
          actions={
            <>
              <LivePill configured={isSupabaseConfigured} lastUpdated={lastUpdated} />
              <button
                onClick={() => load(true)}
                disabled={!isSupabaseConfigured || refreshing}
                className="inline-flex items-center gap-2 rounded-full border border-hair bg-card px-3.5 py-1.5 text-xs font-medium text-ink shadow-sm transition-colors hover:border-brand/40 hover:text-brand disabled:cursor-not-allowed disabled:opacity-50"
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

        <section className="mb-7 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Total episodes" value={counts.total} tone="neutral" icon={<IconStack />} />
          <StatCard
            label="Processing"
            value={counts.processing}
            tone="processing"
            icon={<IconSpinner />}
          />
          <StatCard label="Done" value={counts.done} tone="done" icon={<IconCheck />} />
          <StatCard label="Failed" value={counts.failed} tone="failed" icon={<IconAlert />} />
        </section>

        <div className="overflow-hidden rounded-2xl border border-hair bg-card shadow-card">
          <div className="flex flex-col gap-4 border-b border-hair px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-ink">Episodes</h2>
              <span className="text-xs text-ghost">{visible.length} shown</span>
            </div>
            <SearchBox query={query} onQuery={setQuery} />
          </div>

          <div className="border-b border-hair px-5 py-3">
            <FilterTabs filter={filter} onFilter={setFilter} counts={counts} />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] border-collapse text-sm">
              <thead>
                <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-ghost">
                  <Th className="pl-5">Episode</Th>
                  <Th>Channel</Th>
                  <Th className="min-w-[260px]">Status</Th>
                  <Th>Created</Th>
                  <Th>Completed</Th>
                  <Th>Drive</Th>
                  <Th>Error</Th>
                  <Th className="pr-5 text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
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
                    <Row key={ep.id} ep={ep} onStop={stop} stopping={stopping.has(ep.id)} />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <footer className="mt-6 text-center text-xs text-ghost">
          Slate · Bodycam Horror Studio pipeline
        </footer>
      </main>
    </Shell>
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
}: {
  label: string;
  value: number;
  tone: Tone;
  icon: React.ReactNode;
}) {
  const t: Record<Tone, { value: string; icon: string; ring: string }> = {
    neutral: { value: 'text-ink', icon: 'text-muted bg-sunken', ring: 'hover:border-hair' },
    processing: { value: 'text-amber-600', icon: 'text-amber-600 bg-amber-50', ring: 'hover:border-amber-200' },
    done: { value: 'text-brand', icon: 'text-brand bg-brand-soft', ring: 'hover:border-brand/30' },
    failed: { value: 'text-rose-600', icon: 'text-rose-600 bg-rose-50', ring: 'hover:border-rose-200' },
  };
  const c = t[tone];
  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border border-hair bg-card p-5 shadow-card transition-all hover:shadow-md ${c.ring}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold uppercase tracking-wider text-ghost">{label}</span>
        <span className={`grid h-9 w-9 place-items-center rounded-xl ${c.icon}`}>{icon}</span>
      </div>
      <div className={`mt-4 text-4xl font-semibold tabular-nums tracking-tight ${c.value}`}>{value}</div>
    </div>
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
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              active ? 'bg-ink text-white' : 'text-muted hover:bg-sunken hover:text-ink'
            }`}
          >
            {tab.label}
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                active ? 'bg-white/20 text-white' : 'bg-sunken text-ghost'
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
    <div className="relative sm:w-72">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ghost">
        <IconSearch />
      </span>
      <input
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Search title or episode…"
        className="w-full rounded-xl border border-hair bg-canvas py-2 pl-9 pr-3 text-sm text-ink placeholder:text-ghost outline-none transition-colors focus:border-brand/40 focus:bg-card focus:ring-2 focus:ring-brand/10"
      />
    </div>
  );
}

/* ─────────────────────────── Table ─────────────────────────── */

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-3 font-semibold ${className}`}>{children}</th>;
}

function Row({
  ep,
  onStop,
  stopping,
}: {
  ep: Episode;
  onStop: (ep: Episode) => void;
  stopping: boolean;
}) {
  return (
    <tr className="border-t border-hairsoft transition-colors hover:bg-sunken/40">
      <td className="py-4 pl-5 pr-4">
        <div className="font-medium text-ink">{ep.card_title}</div>
        <div className="mt-0.5 font-mono text-[11px] text-ghost">{ep.episode_name}</div>
      </td>
      <td className="px-4 py-4">
        {ep.channel_name ? (
          <span className="inline-flex items-center rounded-md border border-hair bg-canvas px-2 py-0.5 text-[12px] text-muted">
            {ep.channel_name}
          </span>
        ) : (
          <span className="text-ghost">—</span>
        )}
      </td>
      <td className="px-4 py-4 align-top">
        <StatusBadge status={ep.status} />
        {ep.status === 'processing' && (ep.stage || (ep.progress?.length ?? 0) > 0) && (
          <StageProgress stage={ep.stage} steps={ep.progress ?? []} />
        )}
      </td>
      <td className="px-4 py-4">
        <TimeCell value={ep.created_at} />
      </td>
      <td className="px-4 py-4">
        <TimeCell value={ep.completed_at} />
      </td>
      <td className="px-4 py-4">
        {ep.drive_folder_url ? (
          <a
            href={ep.drive_folder_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-hair bg-card px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand"
          >
            Open
            <IconExternal />
          </a>
        ) : (
          <span className="text-ghost">—</span>
        )}
      </td>
      <td className="max-w-[220px] px-4 py-4">
        {ep.error_message ? (
          <span title={ep.error_message} className="block truncate text-[13px] text-rose-600">
            {ep.error_message}
          </span>
        ) : (
          <span className="text-ghost">—</span>
        )}
      </td>
      <td className="py-4 pl-4 pr-5 text-right">
        {ep.status === 'processing' ? (
          <button
            onClick={() => onStop(ep)}
            disabled={stopping}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <IconStop />
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          <span className="text-ghost">—</span>
        )}
      </td>
    </tr>
  );
}

/**
 * Live status block: the high-level phase plus a row + progress bar for each
 * concurrent sub-task (Script / Images / Voiceover) running in parallel.
 */
function StageProgress({ stage, steps }: { stage: string | null; steps: ProgressStep[] }) {
  return (
    <div className="mt-2 w-[300px] max-w-full space-y-2">
      {stage && (
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
          <span className="h-1 w-1 shrink-0 animate-pulse-soft rounded-full bg-amber-400" />
          <span className="truncate" title={stage}>
            {stage}
          </span>
        </div>
      )}

      {steps.length > 0 ? (
        <div className="space-y-1.5">
          {steps.map((s) => (
            <StepRow key={s.label} step={s} />
          ))}
        </div>
      ) : (
        // Coarse phase with no measurable sub-steps — indeterminate bar.
        <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
          <div className="h-full w-1/3 animate-pulse-soft rounded-full bg-amber-300" />
        </div>
      )}
    </div>
  );
}

function StepRow({ step }: { step: ProgressStep }) {
  const pct = parseProgress(step.text);
  const metric = shortMetric(step.text);
  return (
    <div title={step.text}>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-medium text-ink/75">{step.label}</span>
        <span className="tabular-nums text-ghost">{metric || (pct === null ? '…' : `${pct}%`)}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-sunken">
        {pct !== null ? (
          <div
            className="h-full rounded-full bg-amber-400 transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div className="h-full w-1/3 animate-pulse-soft rounded-full bg-amber-300" />
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: EpisodeStatus }) {
  const map: Record<EpisodeStatus, { label: string; cls: string; dot: string; pulse?: boolean }> = {
    processing: {
      label: 'Processing',
      cls: 'border-amber-200 bg-amber-50 text-amber-700',
      dot: 'bg-amber-500',
      pulse: true,
    },
    done: { label: 'Done', cls: 'border-brand/20 bg-brand-soft text-brand-dim', dot: 'bg-brand' },
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

function TimeCell({ value }: { value: string | null }) {
  if (!value) return <span className="text-ghost">—</span>;
  const d = new Date(value);
  if (isNaN(d.getTime())) return <span className="text-ghost">—</span>;
  const abs = d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <span title={abs} className="whitespace-nowrap text-[13px] text-muted">
      {relativeTime(d)}
    </span>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <tr>
      <td colSpan={8} className="px-6 py-16 text-center">
        <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl border border-hair bg-sunken text-ghost">
          <IconInbox />
        </div>
        <p className="text-sm text-muted">{text}</p>
      </td>
    </tr>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <tr key={i} className="border-t border-hairsoft">
          {Array.from({ length: 8 }).map((__, j) => (
            <td key={j} className={`py-4 ${j === 0 ? 'pl-5 pr-4' : 'px-4'}`}>
              <div className="relative overflow-hidden rounded-md bg-sunken">
                <div className={`h-3.5 ${j === 0 ? 'w-40' : 'w-20'} rounded-md`} />
                <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/70 to-transparent" />
              </div>
            </td>
          ))}
        </tr>
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
function IconStop() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
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
