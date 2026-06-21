'use client';

import { useEffect, useRef, useState } from 'react';

/* ───────────────────────── Modal ───────────────────────── */

/**
 * Base modal: dim + blur backdrop, centered card, ESC + click-outside to close,
 * fade-in. Matches the dashboard's existing dialog styling.
 */
export function Modal({
  open,
  onClose,
  children,
  className = '',
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  labelledBy?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
    >
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={onClose} />
      <div
        className={`animate-fade-in relative z-10 w-full overflow-hidden rounded-3xl border border-hair bg-card shadow-soft ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

/* ──────────────────────── ConfirmDialog ──────────────────────── */

export interface ConfirmConfig {
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

/**
 * A polished replacement for window.confirm. Drive it with a single piece of
 * state: `const [confirm, setConfirm] = useState<ConfirmConfig | null>(null)`,
 * set it from a button, and render `<ConfirmDialog config={confirm} onClose={…} />`.
 */
export function ConfirmDialog({
  config,
  onClose,
}: {
  config: ConfirmConfig | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const open = config !== null;

  // Reset the busy flag whenever a new dialog opens.
  useEffect(() => {
    if (open) setBusy(false);
  }, [open]);

  const run = async () => {
    if (!config) return;
    try {
      setBusy(true);
      await config.onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} className="max-w-md" labelledBy="confirm-title">
      {config && (
        <div className="p-6">
          <div className="flex items-start gap-3">
            <span
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${
                config.danger ? 'bg-rose-50 text-rose-600' : 'bg-brand-soft text-brand'
              }`}
            >
              {config.danger ? <IconAlert /> : <IconQuestion />}
            </span>
            <div className="min-w-0 pt-0.5">
              <h3 id="confirm-title" className="text-sm font-semibold text-ink">
                {config.title}
              </h3>
              {config.message && (
                <div className="mt-1.5 text-[13px] leading-relaxed text-muted">{config.message}</div>
              )}
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-2.5">
            <button
              onClick={onClose}
              disabled={busy}
              className="rounded-lg border border-hair bg-card px-3.5 py-2 text-sm font-medium text-muted transition-colors hover:border-ghost/50 hover:text-ink disabled:opacity-50"
            >
              {config.cancelLabel ?? 'Cancel'}
            </button>
            <button
              onClick={run}
              disabled={busy}
              className={`rounded-lg px-3.5 py-2 text-sm font-semibold text-white transition-colors disabled:opacity-60 ${
                config.danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-brand hover:bg-brand-dim'
              }`}
            >
              {busy ? 'Working…' : (config.confirmLabel ?? 'Confirm')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ───────────────────────── Select ───────────────────────── */

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * Custom dropdown that replaces native <select>: a styled trigger + a floating
 * popover list, with click-outside + ESC to close and a check on the active item.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled = false,
  emptyLabel = 'No options',
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value) ?? null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-hair bg-sunken px-3 py-2 text-left text-sm text-ink outline-none transition-colors hover:bg-card focus:border-brand/40 focus:bg-card focus:ring-2 focus:ring-brand/10 disabled:cursor-not-allowed disabled:opacity-50 data-[open=true]:border-brand/40 data-[open=true]:bg-card data-[open=true]:ring-2 data-[open=true]:ring-brand/10"
        data-open={open}
      >
        <span className={`truncate ${selected ? 'text-ink' : 'text-ghost'}`}>
          {selected ? selected.label : placeholder}
        </span>
        <IconChevron className={`shrink-0 text-ghost transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="listbox"
          className="animate-fade-in absolute z-30 mt-1.5 max-h-60 w-full overflow-auto rounded-xl border border-hair bg-card p-1 shadow-soft"
        >
          {options.length === 0 ? (
            <div className="px-3 py-2 text-sm text-ghost">{emptyLabel}</div>
          ) : (
            options.map((o) => {
              const active = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    active ? 'bg-brand-soft font-medium text-brand-dim' : 'text-ink hover:bg-sunken'
                  }`}
                >
                  <span className="truncate">{o.label}</span>
                  {active && <IconCheck className="shrink-0 text-brand" />}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Toggle ───────────────────────── */

/** An accessible on/off switch (controlled). */
export function Toggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
        checked ? 'bg-brand' : 'bg-hair'
      } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-[22px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

/* ───────────────────────── Icons ───────────────────────── */

function IconChevron({ className = '' }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconCheck({ className = '' }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="m5 13 4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconAlert() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconQuestion() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9.5 9a2.5 2.5 0 0 1 4.5 1.5c0 1.5-2 2-2 3.5m0 3h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
