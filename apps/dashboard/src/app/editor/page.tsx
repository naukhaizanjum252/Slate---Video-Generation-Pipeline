'use client';

import { Shell, INTRO_EDITOR_URL } from '@/components/Shell';

/**
 * Intro editor tab. The editor is an ffmpeg-backed service (it renders video,
 * which Vercel can't do), so it runs on the watcher box and this dashboard proxies
 * it under our OWN origin at /editor-app/ (a next.config rewrite to
 * NEXT_PUBLIC_INTRO_EDITOR_URL). That keeps it same-origin/https with no cert setup
 * on the editor host. When the env isn't set, show setup steps instead of a frame.
 */
export default function EditorPage() {
  return (
    <Shell active="editor">
      {INTRO_EDITOR_URL ? (
        <iframe
          src="/editor-app"
          title="Slate Intro Editor"
          className="block w-full border-0"
          style={{ height: 'calc(100vh - 4rem)' }}
          allow="clipboard-write"
        />
      ) : (
        <main className="mx-auto max-w-2xl px-6 py-16">
          <div className="rounded-3xl border border-hair bg-card p-8 shadow-card">
            <h1 className="text-lg font-semibold text-ink">Intro editor not configured</h1>
            <p className="mt-2 text-sm text-muted">
              The intro editor renders video with ffmpeg, so it runs on the watcher box (not on
              Vercel). The dashboard proxies it under its own origin — set the env to enable this tab.
            </p>
            <ol className="mt-5 space-y-3 text-sm text-muted">
              <li>
                <span className="font-medium text-ink">1.</span> Run the editor with the watcher: set{' '}
                <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink">
                  INTRO_EDITOR=true
                </code>{' '}
                in the watcher env (it boots in-process on port 5174), or run it locally with{' '}
                <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink">
                  pnpm --filter @slate/watcher test-video-ui
                </code>
                .
              </li>
              <li>
                <span className="font-medium text-ink">2.</span> Set{' '}
                <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink">
                  NEXT_PUBLIC_INTRO_EDITOR_URL
                </code>{' '}
                to that editor&apos;s origin (e.g. <span className="font-mono">http://localhost:5174</span>{' '}
                locally, or <span className="font-mono">http://&lt;droplet-ip&gt;:5174</span>) and
                rebuild the dashboard. The dashboard proxies it at{' '}
                <span className="font-mono">/editor-app/</span> — no https needed on the editor host.
              </li>
            </ol>
          </div>
        </main>
      )}
    </Shell>
  );
}
