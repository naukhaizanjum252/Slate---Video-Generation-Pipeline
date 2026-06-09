# Slate

Trello-driven automation for **Bodycam Horror Studio**. Add a card to a Trello
list → the watcher runs the Gradio video pipeline → outputs land in Google Drive
→ a dashboard shows live status.

```
Trello card ──► Watcher (VPS, on the Tailnet) ──► Gradio pipeline ──► Google Drive
                      │                                                     │
                      └──────────────► Supabase ◄───── Dashboard (Vercel) ◄┘
```

## Monorepo layout

```
slate/
├── apps/
│   ├── dashboard/        # Next.js 14 status board (deploys to Vercel)
│   └── watcher/          # Node + Python daemon (runs on a DigitalOcean VPS)
├── packages/
│   └── shared/           # Shared TypeScript types (Episode, PipelineResult)
├── package.json          # pnpm workspace root
├── pnpm-workspace.yaml
└── README.md
```

### How it flows

1. A card is added to the **Queue** list. Title = episode label, description =
   case brief, first image attachment = reference image.
2. The watcher polls every 60s. For each new card it **immediately** moves the
   card to **Processing** and writes a `processing` row to Supabase (before
   running anything, so a restart can't double-trigger).
3. `pipeline.py` drives the three Gradio endpoints (`/cb_pipeline_enhance` →
   `/cb_orchestrated_pipeline` → `/cb_download_all`) and returns a zip path.
4. The bundle is unzipped and uploaded to a new Drive folder named after the
   card title (subfolder structure preserved). The folder is made
   link-viewable.
5. Supabase is updated to `done` with the Drive URL; the card moves to **Done**.
   Any failure routes the card to **Failed** and records the error — the watcher
   process never crashes.

---

## 1. Local dev setup

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
# …then fill both in (see sections below)

# Build the shared package first (others depend on it)
pnpm build:shared

# Run the dashboard locally
pnpm dev:dashboard        # http://localhost:3000

# Run the watcher locally (must be on the Tailnet to reach Gradio)
pnpm dev:watcher

# Smoke-test the pipeline without Trello
pnpm --filter @slate/watcher test-pipeline
```

---

## 2. DigitalOcean VPS setup (Ubuntu 24.04)

```bash
# As root on a fresh Ubuntu 24.04 droplet
apt update && apt upgrade -y

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# pnpm + PM2
npm install -g pnpm pm2

# Python 3 + pip
apt install -y python3 python3-pip git
pip3 install --break-system-packages -r /dev/stdin <<'EOF'
gradio_client>=1.3.0
EOF
# (or after cloning: pip3 install --break-system-packages -r apps/watcher/requirements.txt)

# Verify
node -v && pnpm -v && python3 --version && pm2 -v
```

> If `pip3 install` complains about an externally-managed environment, the
> `--break-system-packages` flag (shown above) is the simplest fix on 24.04.

---

## 3. Tailscale setup (only if running on a separate box)

**Recommended: run the watcher on the same VM as the Gradio studio app.** That
VM is already on the Tailnet, so there's nothing to do here — just confirm the
Gradio server responds locally:

```bash
# On the studio VM
curl -I https://bodycam-studio.tail88fe71.ts.net   # or http://localhost:<gradio-port>
```

Set `GRADIO_BASE_URL` in `apps/watcher/.env` to whatever resolves on that box
(the `…tail88fe71.ts.net` URL works on-box; `http://localhost:<port>` also works).

**Only if you deploy the watcher to a *separate* machine** does it need to join
the Tailnet:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
# Use an auth key the client generates in their Tailscale admin console
sudo tailscale up --authkey=tskey-auth-xxxxxxxxxxxx
tailscale status
curl -I https://bodycam-studio.tail88fe71.ts.net
```

---

## 4. Google Cloud setup (Drive uploads)

1. Go to <https://console.cloud.google.com> and create (or pick) a project.
2. **APIs & Services → Library →** enable **Google Drive API**.
3. **APIs & Services → Credentials → Create credentials → Service account.**
   Give it a name; no roles are required.
4. Open the service account → **Keys → Add key → Create new key → JSON.**
   Download the JSON file.
5. Copy the service account's email (looks like
   `slate@your-project.iam.gserviceaccount.com`).
6. In Google Drive, create the parent folder for episodes. **Share** it with the
   service account email, granting **Editor**. Copy the folder ID from its URL
   (`https://drive.google.com/drive/folders/<THIS_ID>`).
7. Put the values in `apps/watcher/.env`:
   - `GOOGLE_DRIVE_PARENT_FOLDER_ID=<folder id>`
   - `GOOGLE_SERVICE_ACCOUNT_JSON=<the full JSON on one line>`
     Flatten it with: `jq -c . key.json` (or paste it minified).

> The service account uploads on its own behalf, so episode folders are owned by
> the service account but shared "anyone with link can view" automatically.

---

## 5. Trello setup

1. Get your **API key** and a **token** at <https://trello.com/app-key>
   (generate a token from that page; grant read/write).
2. Create four lists on your board: **Queue**, **Processing**, **Done**,
   **Failed**.
3. Find each list ID. Easiest path — list every list on the board:

   ```bash
   # First get the board ID from any card/board URL, then:
   curl "https://api.trello.com/1/boards/<BOARD_ID>/lists?key=<KEY>&token=<TOKEN>" | jq '.[] | {name, id}'
   ```

   Or, if you have a card in the queue list:

   ```bash
   curl "https://api.trello.com/1/cards/<CARD_ID>?key=<KEY>&token=<TOKEN>" | jq '.idList'
   ```

4. Fill into `apps/watcher/.env`:
   `TRELLO_API_KEY`, `TRELLO_TOKEN`, `TRELLO_QUEUE_LIST_ID`,
   `TRELLO_PROCESSING_LIST_ID`, `TRELLO_DONE_LIST_ID`, `TRELLO_FAILED_LIST_ID`.

**Card conventions:** title → episode label (Drive folder name); description →
case brief; first image attachment → reference image.

---

## 6. Supabase setup

1. Create a project at <https://supabase.com>.
2. **SQL Editor →** paste and run `apps/dashboard/supabase-schema.sql`
   (creates the `episodes` table, indexes, and a read-only anon RLS policy).
3. **Project Settings → API**, copy:
   - **Project URL** → `SUPABASE_URL` (watcher) and
     `NEXT_PUBLIC_SUPABASE_URL` (dashboard)
   - **`anon` public key** → `NEXT_PUBLIC_SUPABASE_ANON_KEY` (dashboard)
   - **`service_role` key** → `SUPABASE_SERVICE_ROLE_KEY` (watcher only — never
     ship this to the browser)

---

## 7. Vercel deployment (dashboard)

1. Push the repo to GitHub.
2. In Vercel, **New Project → import the repo**.
3. Set **Root Directory** to `apps/dashboard`.
4. Add env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
5. Deploy. (Build command `next build` and framework detection are automatic;
   the shared package is transpiled via `transpilePackages`.)

---

## Deployment (DigitalOcean Droplet)

The watcher runs on the existing `bodycam-studio` droplet (`45.55.35.225`) alongside the Gradio tool. No Tailscale needed — the watcher calls `http://localhost:7860` directly.

### Connecting to the droplet
- **Browser**: DigitalOcean dashboard → bodycam-studio → Web Console
- **Terminal**: `ssh root@45.55.35.225`

### One-time server setup
```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install pnpm
npm install -g pnpm

# Install PM2
npm install -g pm2

# Install Python dependencies
pip3 install gradio_client --break-system-packages

# Create logs directory
mkdir -p /root/slate/logs

# Clone the repo
cd /root
git clone <your-repo-url> slate
cd slate

# Install Node dependencies
pnpm install

# Build watcher
pnpm --filter @slate/watcher build

# Configure environment
cp apps/watcher/.env.example apps/watcher/.env
nano apps/watcher/.env  # fill in all values

# Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # run the printed command to enable auto-start on reboot
```

Deploying updates

```bash
cd /root/slate
git pull
pnpm --filter @slate/watcher build
pm2 restart slate-watcher
```

Monitoring

```bash
pm2 logs slate-watcher    # live logs
pm2 status                # process status
df -h                     # check disk usage
```

Notes

* `GRADIO_BASE_URL` must be `http://localhost:7860` — both services are on the same machine
* `/tmp/gradio` cleanup runs automatically at 3AM UTC daily via built-in cron
* Disk was previously at 94% due to accumulated Gradio temp files — the cleanup cron prevents recurrence
* Do not run two watcher instances simultaneously — episodes are processed sequentially to respect the 69labs image generation concurrency cap

---

## Environment variables reference

**`apps/watcher/.env`**

| Var | Purpose |
|---|---|
| `TRELLO_API_KEY` / `TRELLO_TOKEN` | Trello auth |
| `TRELLO_QUEUE_LIST_ID` | List the watcher polls |
| `TRELLO_PROCESSING_LIST_ID` | Cards move here while running |
| `TRELLO_DONE_LIST_ID` | Cards move here on success |
| `TRELLO_FAILED_LIST_ID` | Cards move here on failure |
| `GRADIO_BASE_URL` | Gradio host on the Tailnet |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | DB writes |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Drive auth (full JSON, one line) |
| `GOOGLE_DRIVE_PARENT_FOLDER_ID` | Where episode folders are created |
| `PYTHON_BIN` *(optional)* | Path to python3 (default `python3`) |
| `POLL_CRON` *(optional)* | Cron schedule (default every 60s) |

**`apps/dashboard/.env.local`**

| Var | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Read-only anon key |

---

## Design notes

- **Sequential single-worker queue.** 69labs caps us at 4 concurrent image jobs
  and each episode already uses that full budget (16 images in ~4 rounds of 4),
  so episodes are processed strictly **one at a time**. The cron loop only
  discovers and *claims* cards (it never blocks on a running pipeline); a single
  worker drains a FIFO queue, fully awaiting each episode before starting the
  next. Queue depth is the only thing that varies under load.
- **Co-located with the pipeline.** The watcher is designed to run on the **same
  DigitalOcean VM** as the Gradio studio app. `GRADIO_BASE_URL` can therefore
  point at the local server (the `…tail88fe71.ts.net` name resolves on-box, or
  use `http://localhost:<port>`), so no second machine needs to join the Tailnet.
- **Crash-proof.** Every pipeline run is wrapped in try/catch/finally; failures
  are recorded and the card is routed to Failed. Top-level
  `unhandledRejection` / `uncaughtException` guards keep the daemon alive.
- **Idempotent.** Cards are claimed (moved + inserted) before work begins, and
  Supabase's unique `trello_card_id` plus an in-memory `claimed` set prevent
  double-processing across restarts and overlapping ticks.
- **Temp hygiene.** Downloaded images and unzipped bundles use `tmp` and are
  removed in `finally` blocks regardless of outcome.
- **Streaming Gradio.** `pipeline.py` submits the orchestrated job and iterates
  every yielded value, using the final one — matching the generator contract.
```
