# Slate

Trello-driven automation for **Bodycam Horror Studio**. Add a card to a channel's
Trello list → the watcher runs the Gradio video pipeline → outputs land in Google
Drive → a dashboard shows live status.

```
Trello card ──► Watcher (DigitalOcean droplet) ──► Gradio pipeline ──► Google Drive
                      │                                                     │
                      └──────────────► Supabase ◄───── Dashboard (Vercel) ◄┘
```

The watcher, the dashboard, and the studio app never talk to each other directly —
**Supabase is the shared state store** they all read from and write to.

> **Setting it up?** This file is the overview + reference. For step-by-step
> instructions (credentials, deploy, first run), follow **[SETUP.md](SETUP.md)**.

## Monorepo layout

```
slate/
├── apps/
│   ├── dashboard/        # Next.js 14 status board + channel config (deploys to Vercel)
│   └── watcher/          # Node + Python daemon (runs on a DigitalOcean droplet)
├── packages/
│   └── shared/           # Shared TypeScript types (Episode, Channel, PipelineResult)
├── package.json          # pnpm workspace root
├── pnpm-workspace.yaml
└── README.md
```

## How it flows

1. A card is added to a channel's **source list**. Title = episode label (becomes
   the Drive folder name), description = case brief, first image attachment =
   reference image.
2. The watcher polls every 60s. Cards are **not moved between lists** — for each
   new card it writes a `processing` row to Supabase (before running anything, so
   a restart can't double-trigger). De-duplication is entirely Supabase-driven via
   the unique `trello_card_id`.
3. New cards are added to a single in-process FIFO queue and processed **one at a
   time** by a sequential worker (see Design notes). `pipeline.py` drives the
   Gradio endpoints — `/cb_pipeline_enhance` → `/cb_orchestrated_pipeline` →
   `/cb_download_all` (plus an optional `/cb_build_video`) — and returns a zip path.
4. The bundle is unzipped and uploaded to a new Drive folder named after the card
   title (subfolder structure preserved). The folder is made link-viewable.
5. Supabase is updated to `done` with the Drive URL; the card is moved to the
   channel's **resolve list** and a comment with the Drive link is posted. Any
   failure records the error and turns the dashboard row red — the watcher process
   never crashes.

**Channels** (one row per YouTube channel) hold the Trello board, the source list,
the resolve list, and a Drive folder. They are managed from the dashboard's
**Settings** page — there are no list IDs in any env file.

## Dashboard features

- Live status of every episode (polls Supabase every 30s), with a per-phase
  pipeline stepper and parallel sub-task progress (Script / Images / Voiceover).
- **Stop** a running episode (sets a cancel flag the watcher acts on within ~10s).
- **Retry** a failed/cancelled episode (deletes its record so the watcher re-picks
  the card — it must still be in the source list).
- **Delete** an episode record.
- **Settings** page: add/edit/delete channels using Trello board + list dropdowns.

---

## Local dev setup

Prereqs: **Node.js 20+**, **pnpm 9+**, **Python 3.10+**.

```bash
git clone <your-repo-url> slate
cd slate
pnpm install

# Python deps for the pipeline helper
pip3 install -r apps/watcher/requirements.txt

# Env files
cp apps/watcher/.env.example apps/watcher/.env
cp apps/dashboard/.env.example apps/dashboard/.env.local
# …then fill both in (see SETUP.md)

# Build the shared package FIRST — the watcher and dashboard depend on it
pnpm build:shared

# Run the dashboard locally
pnpm dev:dashboard        # http://localhost:3000

# Run the watcher locally (must be able to reach the Gradio server)
pnpm dev:watcher

# Smoke-test the pipeline without Trello (writes a Supabase row, runs a real
# episode through Gradio → Drive)
pnpm --filter @slate/watcher test-pipeline
```

> ⚠️ Always build `@slate/shared` before building the watcher or dashboard. They
> resolve it from `packages/shared/dist`, which is gitignored. `pnpm build` (root)
> builds everything in the right order; a bare `pnpm --filter @slate/watcher build`
> assumes `shared` is already built.

---

## Deployment

### Dashboard (Vercel)

1. Push the repo to GitHub.
2. In Vercel, **New Project → import the repo**.
3. Set **Root Directory** to `apps/dashboard`.
4. Add the five env vars (see reference below): the two `NEXT_PUBLIC_*` plus
   `SUPABASE_SERVICE_ROLE_KEY`, `TRELLO_API_KEY`, `TRELLO_TOKEN`.
5. Deploy. (`next build` and framework detection are automatic; the shared package
   is consumed via `transpilePackages`.)

### Watcher (DigitalOcean droplet)

The watcher runs on the existing `bodycam-studio` droplet (`45.55.35.225`)
alongside the Gradio tool. No Tailscale needed — it calls `http://localhost:7860`
directly.

**Connecting:** DigitalOcean dashboard → bodycam-studio → Web Console, or
`ssh root@45.55.35.225`.

**One-time setup:**

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# pnpm + PM2
npm install -g pnpm pm2

# Python client for the pipeline
pip3 install gradio_client --break-system-packages

# Logs dir
mkdir -p /root/slate/logs

# Get the code
cd /root
git clone <your-repo-url> slate
cd slate
pnpm install
pnpm build:shared                          # build shared first
pnpm --filter @slate/watcher build

# Env — fill in all values (see SETUP.md / reference below)
cp apps/watcher/.env.example apps/watcher/.env
nano apps/watcher/.env

# Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # run the printed command so it survives reboots
```

**Deploying updates:**

```bash
cd /root/slate
git pull
pnpm build:shared && pnpm --filter @slate/watcher build
pm2 restart slate-watcher
```

**Monitoring:**

```bash
pm2 logs slate-watcher    # live logs
pm2 status                # process status
df -h                     # disk usage
```

Notes:
- `GRADIO_BASE_URL` must be `http://localhost:7860` — both services share the machine.
- `pipeline.py` is run from `apps/watcher/src/` (the build does **not** copy it into
  `dist/`), so keep the `src/` tree on the server after building.
- `/tmp/gradio` cleanup runs automatically at 3 AM UTC daily via a built-in cron.
- Never run two watcher instances at once — episodes are processed sequentially to
  respect the 69labs image-generation concurrency cap, and queue state is in-memory
  per process.

---

## Supabase setup

1. Create a project at <https://supabase.com>.
2. **SQL Editor →** paste and run `apps/dashboard/supabase-schema.sql`. It creates
   the `channels`, `episodes`, and `drive_auth` tables, indexes, and RLS policies
   (read-only anon on episodes/channels; `drive_auth` is service-role only). It is
   idempotent and self-migrating (safe to re-run; it migrates an older 4-list
   schema if present). If you already ran an earlier version, **re-run it** to add
   the `drive_auth` table the Connect-Google feature needs.
3. **Project Settings → API**, copy:
   - **Project URL** → `SUPABASE_URL` (watcher), `NEXT_PUBLIC_SUPABASE_URL` (dashboard)
   - **`anon` public key** → `NEXT_PUBLIC_SUPABASE_ANON_KEY` (dashboard, browser-safe)
   - **`service_role` key** → `SUPABASE_SERVICE_ROLE_KEY` (watcher **and** the
     dashboard's server — never expose it to the browser)

The anon key may only **read** both tables (enforced by RLS). All writes go through
the watcher and the dashboard's server-side API routes, both using the service-role
key (which bypasses RLS).

---

## Environment variables reference

### `apps/watcher/.env`

| Var | Purpose |
|---|---|
| `TRELLO_API_KEY` / `TRELLO_TOKEN` | Trello auth (key + token only; list IDs live per-channel in Supabase) |
| `GRADIO_BASE_URL` | Gradio host (default `http://localhost:7860`) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | DB writes |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Drive OAuth client (used to refresh the access token) |
| `GOOGLE_OAUTH_REFRESH_TOKEN` *(optional)* | Fallback Drive token, used only if no account is connected in the dashboard (see `get-drive-token` script) |
| `ENABLE_BUILD_VIDEO` *(optional)* | Render the final MP4 (`/cb_build_video`); default `false` (asset bundle only) |
| `POLL_CRON` *(optional)* | 6-field cron, default every 60s (`*/60 * * * * *`) |
| `PIPELINE_TIMEOUT_MIN` *(optional)* | Hard cap on one episode (default 60) |
| `STALL_TIMEOUT_MIN` *(optional)* | Fail if no progress reported for this long (default 30) |
| `STUDIO_LOG_UNIT` *(optional)* | systemd unit whose journal is captured into errors (default `bodycam-studio`; blank to disable) |
| `REUSE_EXISTING` *(optional)* | Reuse an already-generated bundle if found (default `true`) |
| `PROBE_TIMEOUT_MIN` *(optional)* | Max wait on the reuse probe (default 2) |
| `PYTHON_BIN` *(optional)* | Path to python3 (default `python3`) |

> Drive uploads use **OAuth** (the watcher uploads as the real account that owns the
> folder). Service accounts can't store files in a personal Gmail Drive — they have
> no storage quota — so OAuth is required. There is **no** `GOOGLE_DRIVE_PARENT_FOLDER_ID`;
> each channel's Drive folder is set per-channel in the dashboard Settings page.

### `apps/dashboard/.env.local`

| Var | Browser-visible? | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Read-only anon key (powers the live board) |
| `SUPABASE_SERVICE_ROLE_KEY` | no (server) | Powers the Settings page channel CRUD + the connected Drive account |
| `TRELLO_API_KEY` | no (server) | Trello board/list dropdowns |
| `TRELLO_TOKEN` | no (server) | Trello board/list dropdowns |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | no (server) | "Connect Google Drive" button + folder dropdown (must be a **Web** OAuth client) |
| `GOOGLE_OAUTH_REDIRECT_URI` *(optional)* | no (server) | Override the callback URL if the request origin differs from the public URL |

> Only the two `NEXT_PUBLIC_*` values reach the browser. The service-role key, the
> Trello credentials, and the Google OAuth secret are server-only — never add a
> `NEXT_PUBLIC_` prefix to them.

### Connecting Google Drive (from the dashboard)

The uploading account is chosen in the dashboard, not on the droplet:

1. In Google Cloud, create a **Web application** OAuth client and add this app's
   callback as an authorized redirect URI:
   `https://<your-dashboard-url>/api/drive/oauth/callback` (and
   `http://localhost:3000/api/drive/oauth/callback` for local dev). Put its
   client ID/secret in the dashboard env (`GOOGLE_OAUTH_CLIENT_ID` /
   `GOOGLE_OAUTH_CLIENT_SECRET`).
2. On the **Settings** page, click **Connect Google Drive** and approve access.
   The refresh token is stored server-side in Supabase (`drive_auth`, service-role
   only — never exposed to the browser).
3. Each channel's folder is then chosen from a **dropdown** of that account's
   folders. To switch accounts later, just click **Reconnect** — no redeploy. The
   watcher reads the connected account from Supabase at upload time.

---

## Design notes

- **Sequential single-worker queue.** 69labs caps us at 4 concurrent image jobs and
  each episode already uses that full budget (16 images in ~4 rounds of 4), so
  episodes are processed strictly **one at a time**. The cron loop only discovers and
  *claims* cards (it never blocks on a running pipeline); a single worker drains a
  FIFO queue, fully awaiting each episode before starting the next.
- **Co-located with the pipeline.** The watcher runs on the **same droplet** as the
  Gradio studio app, so `GRADIO_BASE_URL` points at `http://localhost:7860`.
- **Crash-proof.** Every pipeline run is wrapped in try/catch/finally; failures are
  recorded and the episode turns red. Top-level `unhandledRejection` /
  `uncaughtException` guards keep the daemon alive.
- **Idempotent.** A `processing` row is inserted before work begins, and Supabase's
  unique `trello_card_id` plus an in-memory `claimed` set prevent double-processing
  across restarts and overlapping ticks. Cards stay in the source list; status is
  tracked in Supabase, not by moving cards (they move only to the resolve list on done).
- **Two safety nets per run.** A hard timeout caps the whole run; a separate stall
  watchdog fails fast if no progress is reported for `STALL_TIMEOUT_MIN`, so a wedged
  step surfaces clearly instead of hanging.
- **Cancellable.** The dashboard's Stop button sets `cancel_requested`; the watcher
  polls it (~10s), kills the running pipeline or drops it from the queue, and marks
  the episode `cancelled`.
- **Reuse on retry.** Before generating, the watcher can probe `/cb_download_all` and,
  if a *complete* bundle already exists for the episode, skip generation and just
  upload — making retries cheap.
- **Temp hygiene.** Downloaded images and unzipped bundles use temp dirs removed in
  `finally` blocks; a daily 3 AM UTC cron clears `/tmp/gradio` to prevent disk exhaustion.
- **Streaming Gradio.** `pipeline.py` submits the orchestrated job and iterates every
  yielded value, relaying concurrent sub-task progress (Script / Images / Voiceover)
  to the dashboard, using the final yield as the result.
```