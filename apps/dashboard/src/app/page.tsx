'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { Episode, EpisodeStatus, PhaseStatus, ProgressStep, TimelinePhase } from '@slate/shared';
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
  const [showError, setShowError] = useState(false);
  const [open, setOpen] = useState(false);
  const hasTimeline = (ep.timeline?.length ?? 0) > 0;
  return (
    <>
    <tr className="border-t border-hairsoft transition-colors hover:bg-sunken/40">
      <td className="py-4 pl-5 pr-4">
        {hasTimeline ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-start gap-2 text-left"
            title={open ? 'Hide pipeline' : 'Show pipeline'}
          >
            <IconChevron open={open} />
            <span>
              <span className="block font-medium text-ink">{ep.card_title}</span>
              <span className="mt-0.5 block font-mono text-[11px] text-ghost">{ep.episode_name}</span>
            </span>
          </button>
        ) : (
          <div className="pl-6">
            <div className="font-medium text-ink">{ep.card_title}</div>
            <div className="mt-0.5 font-mono text-[11px] text-ghost">{ep.episode_name}</div>
          </div>
        )}
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
      <td className="max-w-[260px] px-4 py-4 align-top">
        {ep.error_message ? (
          <button
            type="button"
            onClick={() => setShowError((v) => !v)}
            title={showError ? 'Click to collapse' : 'Click to read full error'}
            className={`text-left text-[13px] text-rose-600 hover:text-rose-700 ${
              showError ? 'whitespace-pre-wrap break-words' : 'block max-w-full truncate'
            }`}
          >
            {ep.error_message}
          </button>
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
    {open && hasTimeline && (
      <tr className="border-t border-hairsoft bg-sunken/30">
        <td colSpan={8} className="px-6 pb-7 pt-3">
          <EpisodeStepper timeline={ep.timeline ?? []} />
        </td>
      </tr>
    )}
    </>
  );
}

/** Ordered pipeline phases (build-video omitted — off by default). */
const PHASES: { key: string; label: string }[] = [
  { key: 'Downloading reference', label: 'Reference image' },
  { key: 'Enhancing reference', label: 'Enhance reference' },
  { key: 'Generating script & assets', label: 'Script & assets' },
  { key: 'Packaging files', label: 'Package files' },
  { key: 'Unpacking bundle', label: 'Unpack bundle' },
  { key: 'Uploading to Drive', label: 'Upload to Drive' },
];

type PhaseState = 'done' | 'active' | 'pending';

/**
 * Live status as a phase checklist: completed phases get a green check, the
 * current one is highlighted (with its sub-task bars), upcoming ones are dimmed.
 * Always shows the whole pipeline so earlier steps stay visible.
 */
function StageProgress({ stage, steps }: { stage: string | null; steps: ProgressStep[] }) {
  const idx = stage ? PHASES.findIndex((p) => p.key === stage) : -1;

  // Unknown/early phase (e.g. "Queued") — simple current-line fallback.
  if (idx === -1) {
    return (
      <div className="mt-2 w-[300px] max-w-full space-y-2">
        {stage && (
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full bg-brand" />
            <span className="truncate" title={stage}>
              {stage}
            </span>
          </div>
        )}
        {steps.length > 0 ? (
          <div className="space-y-2.5">
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

  return (
    <ol className="mt-2.5 w-[300px] max-w-full space-y-2.5">
      {PHASES.map((p, i) => {
        const state: PhaseState = i < idx ? 'done' : i === idx ? 'active' : 'pending';
        return (
          <li key={p.key}>
            <div className="flex items-center gap-2">
              <PhaseIcon state={state} />
              <span
                className={`text-[12px] ${
                  state === 'active'
                    ? 'font-semibold text-ink'
                    : state === 'done'
                      ? 'text-muted'
                      : 'text-ghost'
                }`}
              >
                {p.label}
              </span>
            </div>
            {state === 'active' && (
              <div className="ml-[26px] mt-2">
                {steps.length > 0 ? (
                  <div className="space-y-2.5">
                    {steps.map((s) => (
                      <StepRow key={s.label} step={s} />
                    ))}
                  </div>
                ) : (
                  <IndeterminateBar />
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function PhaseIcon({ state }: { state: PhaseState }) {
  if (state === 'done') {
    return (
      <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-emerald-500 text-white">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="m5 12.5 4.5 4.5L19 7"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }
  if (state === 'active') {
    return (
      <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full border-2 border-brand">
        <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-brand" />
      </span>
    );
  }
  return <span className="h-4 w-4 shrink-0 rounded-full border-2 border-hair" />;
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
    <div className="flex items-start overflow-x-auto pb-1">
      {timeline.map((ph, i) => (
        <Fragment key={ph.key}>
          <PhaseColumn phase={ph} index={i} />
          {i < timeline.length - 1 && (
            <div
              className={`mt-[13px] h-0.5 min-w-[24px] flex-1 rounded-full ${
                ph.status === 'done'
                  ? 'bg-emerald-400'
                  : ph.status === 'active'
                    ? 'bg-brand/40'
                    : 'bg-hair'
              }`}
            />
          )}
        </Fragment>
      ))}
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
    <div className="flex w-[130px] shrink-0 flex-col items-center px-1 text-center">
      <StepNodeCircle status={phase.status} />
      <div className="mt-2 text-[10px] font-semibold uppercase tracking-wider text-ghost">
        Step {index + 1}
      </div>
      <div className="text-[13px] font-semibold text-ink">{phase.label}</div>
      <div className={`text-[11px] font-medium ${statusColor}`}>
        {PHASE_STATUS_TEXT[phase.status]}
      </div>
      {phase.steps && phase.steps.length > 0 && (
        <div className="mt-3 w-full space-y-1.5 text-left">
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
      <span className="grid h-7 w-7 place-items-center rounded-full bg-emerald-500 text-white shadow-sm">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="m5 12.5 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (status === 'active') {
    return (
      <span className="grid h-7 w-7 place-items-center rounded-full border-[3px] border-brand bg-card shadow-sm">
        <span className="h-2.5 w-2.5 animate-pulse-soft rounded-full bg-brand" />
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="grid h-7 w-7 place-items-center rounded-full bg-rose-500 text-white shadow-sm">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return <span className="h-7 w-7 rounded-full border-2 border-hair bg-card" />;
}

function SubStepNode({ step }: { step: ProgressStep }) {
  const pct = parseProgress(step.text);
  const done = isStepDone(step.text) || pct === 100;
  const metric = shortMetric(step.text);
  return (
    <div className="flex items-center gap-1.5" title={step.text}>
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${
          done ? 'bg-emerald-500' : 'animate-pulse-soft bg-brand'
        }`}
      />
      <span className="text-[11px] font-medium text-ink/80">{step.label}</span>
      <span className="ml-auto text-[10px] tabular-nums text-ghost">
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
