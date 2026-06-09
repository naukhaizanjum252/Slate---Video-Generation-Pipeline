'use client';

import Link from 'next/link';

type Active = 'dashboard' | 'settings';

const NAV: { key: Active; href: string; label: string; icon: React.ReactNode }[] = [
  { key: 'dashboard', href: '/', label: 'Dashboard', icon: <IconGrid /> },
  { key: 'settings', href: '/settings', label: 'Settings', icon: <IconGear /> },
];

/**
 * App shell: a fixed sidebar on desktop and a compact top bar on mobile, shared
 * by every page so navigation and branding stay consistent.
 */
export function Shell({ active, children }: { active: Active; children: React.ReactNode }) {
  return (
    <div className="min-h-screen lg:flex">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 flex-col border-r border-hair bg-card/70 backdrop-blur lg:flex">
        <div className="flex items-center gap-3 px-5 py-5">
          <LogoMark />
          <div className="leading-tight">
            <div className="text-[15px] font-semibold tracking-tight text-ink">Slate</div>
            <div className="text-[11px] text-muted">Bodycam Horror Studio</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-2">
          {NAV.map((item) => (
            <NavItem
              key={item.key}
              href={item.href}
              label={item.label}
              icon={item.icon}
              active={active === item.key}
            />
          ))}
        </nav>

        <div className="border-t border-hair px-5 py-4">
          <div className="flex items-center gap-2 text-[11px] text-ghost">
            <span className="h-1.5 w-1.5 rounded-full bg-brand/50" />
            Automation · research preview
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-hair bg-card/80 px-4 py-3 backdrop-blur lg:hidden">
        <div className="flex items-center gap-2.5">
          <LogoMark />
          <span className="text-[15px] font-semibold tracking-tight text-ink">Slate</span>
        </div>
        <nav className="flex items-center gap-1">
          {NAV.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                active === item.key ? 'bg-ink text-white' : 'text-muted hover:bg-sunken hover:text-ink'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>

      {/* Main content */}
      <div className="flex-1 lg:pl-64">{children}</div>
    </div>
  );
}

/**
 * Standard page header used inside the shell: title, optional subtitle, and a
 * right-hand actions slot.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2.5">{actions}</div>}
    </div>
  );
}

function NavItem({
  href,
  label,
  icon,
  active,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? 'bg-brand-soft text-brand-dim'
          : 'text-muted hover:bg-sunken hover:text-ink'
      }`}
    >
      <span className={active ? 'text-brand' : 'text-ghost'}>{icon}</span>
      {label}
    </Link>
  );
}

function LogoMark() {
  return (
    <div className="grid h-9 w-9 place-items-center rounded-xl border border-brand/20 bg-brand-soft shadow-glow">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z"
          stroke="#059669"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M12 8v8M8 10v4M16 10v4" stroke="#059669" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </div>
  );
}

function IconGrid() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
