'use client';

import Link from 'next/link';

type Active = 'dashboard' | 'settings';

const NAV: { key: Active; href: string; label: string }[] = [
  { key: 'dashboard', href: '/', label: 'Dashboard' },
  { key: 'settings', href: '/settings', label: 'Settings' },
];

/**
 * App shell with a sticky top navigation bar (logo + underline nav), shared by
 * every page. No user avatar / notification chrome — just the product nav.
 */
export function Shell({ active, children }: { active: Active; children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-hair bg-card/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-2 px-6">
          <div className="flex items-center gap-2.5 pr-6">
            <LogoMark />
            <span className="text-[17px] font-bold tracking-tight text-ink">Slate</span>
          </div>

          <nav className="flex h-full items-center gap-1">
            {NAV.map((item) => {
              const on = active === item.key;
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  aria-current={on ? 'page' : undefined}
                  className={`inline-flex h-16 items-center border-b-2 px-3 text-[13px] font-semibold uppercase tracking-wide transition-colors ${
                    on
                      ? 'border-navy text-ink'
                      : 'border-transparent text-muted hover:text-ink'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>

      {children}
    </div>
  );
}

/**
 * Standard page header inside the shell: a large uppercase title, optional
 * subtitle, and a right-hand actions slot (search, refresh, etc.).
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
    <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div>
        <h1 className="text-3xl font-bold uppercase tracking-tight text-ink sm:text-[34px]">
          {title}
        </h1>
        {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </div>
  );
}

function LogoMark() {
  return (
    <div className="grid h-9 w-9 place-items-center rounded-xl bg-navy shadow-glow">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z"
          stroke="#ffffff"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M12 8v8M8 10v4M16 10v4" stroke="#7aa2f7" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </div>
  );
}
