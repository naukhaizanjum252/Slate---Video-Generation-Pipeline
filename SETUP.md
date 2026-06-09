# Slate — Step-by-Step Setup Guide

This walks you through every value you need, where to get it, and how to get the
system running end-to-end. Work top to bottom. Budget ~45 min the first time.

There are two things to run:

- **Watcher** — runs on the DigitalOcean droplet (`45.55.35.225`) next to the
  Gradio tool. Needs `apps/watcher/.env`.
- **Dashboard** — a Next.js site (Vercel, or local). Needs `apps/dashboard/.env.local`.
  This is also where you **configure channels** (Trello board + lists) via
  dropdowns — no list IDs go in any env file anymore.

You'll collect credentials from **Supabase**, **Google**, and **Trello**, drop
them into those two env files, deploy, then add your channel(s) from the
dashboard Settings page.

---

## Part A — Supabase (database + dashboard data)

You'll get three values here: a URL, a `service_role` key, and an `anon` key.

1. Go to <https://supabase.com>, sign in, **New project**. Pick a name and a
   strong database password (you won't need the password again for this).
2. Wait for it to finish provisioning (~2 min).
3. Left sidebar → **SQL Editor** → **New query**. Open the file
   `apps/dashboard/supabase-schema.sql` from this repo, paste its contents in,
   and click **Run**. You should see "Success". This creates the `channels` and
   `episodes` tables, indexes, and read-only policies for the dashboard.
   (It's safe to re-run later — everything is idempotent.)
4. Left sidebar → **Project Settings** (gear) → **API**. Copy these:
   - **Project URL** → this is `SUPABASE_URL` (watcher),
     `NEXT_PUBLIC_SUPABASE_URL` (dashboard).
   - **Project API keys → `anon` `public`** → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
     (dashboard, browser-safe).
   - **Project API keys → `service_role` `secret`** → used by BOTH the watcher
     (`SUPABASE_SERVICE_ROLE_KEY`) and the dashboard's server
     (`SUPABASE_SERVICE_ROLE_KEY`). It bypasses security rules, so it only ever
     goes in server-side env — never `NEXT_PUBLIC_`.

> ✅ You now have: `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`,
> `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

---

## Part B — Google Drive (where episode files land)

Uploads use **OAuth** (the watcher uploads as you, the real account that owns the
folder). Service accounts can't store files in a personal Gmail Drive — they have
no storage quota — so OAuth is required. You'll get three values: an OAuth client
ID + secret, and a refresh token; plus a Drive folder ID per channel.

1. Go to <https://console.cloud.google.com>. Create a project or pick one.
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **APIs & Services → OAuth consent screen** → choose **External** → fill the
   minimal fields (app name, your email). Add the scope
   `.../auth/drive`. Then **Publish app** (set Publishing status to *In
   production*) so the refresh token doesn't expire after 7 days. You can ignore
   the "verification" prompts for personal use.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   Application type **Desktop app** → Create. Copy the **Client ID** and
   **Client secret** → `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`.
5. Get the refresh token (run on your Mac — it opens a browser):
   ```bash
   cd "slate"
   GOOGLE_OAUTH_CLIENT_ID=xxx GOOGLE_OAUTH_CLIENT_SECRET=yyy \
     pnpm --filter @slate/watcher get-drive-token
   ```
   Open the printed URL, approve access (click through the "unverified app"
   warning: **Advanced → Go to … (unsafe)**). It prints
   `GOOGLE_OAUTH_REFRESH_TOKEN=…` — copy that value.
6. In **Google Drive**, create a folder for each channel's episodes. (No sharing
   needed — uploads run as you, so you already own them.) Copy each folder's ID
   from its URL: `https://drive.google.com/drive/folders/`**`THIS_LONG_ID`** —
   you'll paste it into the channel's **Drive folder ID** field (Part J).

> ✅ You now have: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
> `GOOGLE_OAUTH_REFRESH_TOKEN`, and a Drive folder ID per channel.

---

## Part C — Trello (the trigger)

You only need a **key** and a **token** now. The board and list IDs are chosen
later from dropdowns in the dashboard — you do **not** put them in env files.

1. Go to <https://trello.com/app-key>. Copy the **Key** → `TRELLO_API_KEY`.
2. On that same page click the **Token** link, authorize, and copy the long
   token → `TRELLO_TOKEN`.
3. On your Trello board, make sure each channel has **one source list** — the
   list you'll drop episode cards into (name it whatever you like, e.g.
   "Episodes" or "Queue"). The watcher reads from this single list and never
   moves cards; status is shown on the dashboard. You can run multiple channels
   off one board (each with its own source list) or use separate boards.

> ✅ You now have: `TRELLO_API_KEY`, `TRELLO_TOKEN`.
> (No list IDs — the source list is chosen from a dropdown in Part J.)

---

## Part D — Confirm the Gradio port

The watcher calls the Gradio tool locally. On the droplet (`ssh root@45.55.35.225`):

```bash
curl -I http://localhost:7860
```

If you get an HTTP response, `7860` is correct (the default). If not, use the
port the studio app actually serves on in `GRADIO_BASE_URL`.

---

## Part E — Fill the watcher env (`apps/watcher/.env`)

```bash
cp apps/watcher/.env.example apps/watcher/.env
```

Edit `apps/watcher/.env` (values are examples):

```ini
# Trello — key + token only (board/list IDs live per-channel in the dashboard)
TRELLO_API_KEY=abc123...
TRELLO_TOKEN=ATTAxxxxxxxx...

# Gradio (same machine as the watcher)
GRADIO_BASE_URL=http://localhost:7860

# Supabase
SUPABASE_URL=https://xxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...   # the service_role secret

# Google Drive (OAuth — per-channel folders are set in the dashboard)
GOOGLE_OAUTH_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-...
GOOGLE_OAUTH_REFRESH_TOKEN=1//0g...

# Pipeline — leave video off for now (asset bundle only)
ENABLE_BUILD_VIDEO=false

# Optional
POLL_CRON=*/60 * * * * *
```

Notes:
- The Google values are OAuth (Part B), not a service-account JSON.
- `SUPABASE_SERVICE_ROLE_KEY` is the **service_role** key, not the anon key.
- There is no `GOOGLE_DRIVE_PARENT_FOLDER_ID` — each channel's folder is set in
  the dashboard (Part J) and is mandatory.
- `ENABLE_BUILD_VIDEO=false` skips the final MP4 render; flip to `true` later.

---

## Part F — Fill the dashboard env (`apps/dashboard/.env.local`)

```bash
cp apps/dashboard/.env.example apps/dashboard/.env.local
```

Edit it:

```ini
# Public (browser) — read-only
NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGci...   # the anon public key

# Server-only — power the Settings page (channel CRUD + Trello dropdowns)
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...        # service_role secret (same as watcher)
TRELLO_API_KEY=abc123...
TRELLO_TOKEN=ATTAxxxxxxxx...
```

> ⚠️ Only the two `NEXT_PUBLIC_*` values reach the browser. The service-role key
> and Trello credentials are server-only — never add a `NEXT_PUBLIC_` prefix to
> them. On Vercel, add all five as project env vars.

---

## Part G — Push the code to GitHub

```bash
cd "slate"        # the repo root
git init
git add .
git commit -m "Initial slate"
git branch -M main
git remote add origin <your-repo-url>   # create an empty repo on GitHub first
git push -u origin main
```

`.gitignore` already excludes `.env`, `.env.local`, and service-account JSON.

---

## Part H — Deploy the watcher on the droplet

SSH in: `ssh root@45.55.35.225` (or use the DigitalOcean web console). Then:

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
pnpm --filter @slate/watcher build

# Env — paste the values from Part E
cp apps/watcher/.env.example apps/watcher/.env
nano apps/watcher/.env

# Start it
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # run the command it prints, so it survives reboots
```

Check it's alive:

```bash
pm2 logs slate-watcher
```

On boot it logs "Slate watcher starting". Until you add a channel (Part J) it
will log "No enabled channels configured" each poll — that's expected.

---

## Part I — Deploy the dashboard (Vercel)

1. Go to <https://vercel.com>, **Add New → Project**, import your GitHub repo.
2. Set **Root Directory** to `apps/dashboard`.
3. Add all five env vars from Part F (the two `NEXT_PUBLIC_*` plus
   `SUPABASE_SERVICE_ROLE_KEY`, `TRELLO_API_KEY`, `TRELLO_TOKEN`).
4. **Deploy.** Open the URL.

(Or run locally instead: `pnpm dev:dashboard` → <http://localhost:3000>.)

---

## Part J — Configure your channel(s) in the dashboard

This replaces the old list-ID env vars.

1. Open the dashboard and click **Settings** (top-right).
2. Under **Add a channel**:
   - **Channel name** — e.g. "Bodycam Horror Studio" (becomes the dashboard
     label).
   - **Trello board** — pick from the dropdown.
   - **Source list** — pick from the dropdown (it populates from the board you
     chose). This is the single list the watcher polls.
   - **Google Drive folder ID** — required. Paste the channel's folder ID from
     Part B (must be shared with the service-account email).
   - **Enabled** — leave checked so the watcher polls it.
3. **Create channel.** It appears in the list below; you can Edit or Delete it
   anytime. Repeat for each channel.

Within ~60s the watcher (Part H) picks up the new channel and starts polling its
source list.

---

## Part K — Test the whole flow

1. On Trello, add a card to a channel's **source list**:
   - **Title** → the episode name (becomes the Drive folder name).
   - **Description** → the full case brief.
   - **Attachment** → the reference image (first image attachment is used).
2. Within ~60s a yellow **processing** row appears on the dashboard (with the
   channel name). The card stays in the source list — status lives on the
   dashboard, not on Trello.
3. After ~15–25 min: outputs land in the channel's Drive folder and the
   dashboard row turns green (**done**) with an **Open** link.
4. On failure the dashboard row turns red with the error message. The watcher
   keeps running. (The card remains in the source list; it won't be retried
   automatically — see the troubleshooting note on reprocessing.)

> Quick smoke test without Trello (run on the droplet after Part E):
> `pnpm --filter @slate/watcher test-pipeline` — runs one episode through
> Gradio → Drive → Supabase. It writes a Supabase row but doesn't touch Trello.

---

## Environment variable reference

### `apps/watcher/.env` (on the droplet)
| Variable | Where it comes from |
|---|---|
| `TRELLO_API_KEY` | Part C, step 1 |
| `TRELLO_TOKEN` | Part C, step 2 |
| `GRADIO_BASE_URL` | `http://localhost:7860` (Part D) |
| `SUPABASE_URL` | Part A, step 4 (Project URL) |
| `SUPABASE_SERVICE_ROLE_KEY` | Part A, step 4 (service_role secret) |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | Part B, step 4 |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | Part B, step 5 |
| `ENABLE_BUILD_VIDEO` *(optional)* | `false` (asset bundle only) until you want the MP4 |
| `POLL_CRON` *(optional)* | leave default `*/60 * * * * *` |
| `PYTHON_BIN` *(optional)* | only if `python3` isn't on PATH |

*(No `GOOGLE_DRIVE_PARENT_FOLDER_ID` — each channel's Drive folder is mandatory
and set in the dashboard, Part J.)*

*(No `TRELLO_*_LIST_ID` — list config is per-channel in Supabase, set in Part J.)*

### `apps/dashboard/.env.local` (Vercel or local)
| Variable | Browser-visible? | Where it comes from |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Part A, step 4 (Project URL) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Part A, step 4 (anon public key) |
| `SUPABASE_SERVICE_ROLE_KEY` | no (server) | Part A, step 4 (service_role secret) |
| `TRELLO_API_KEY` | no (server) | Part C, step 1 |
| `TRELLO_TOKEN` | no (server) | Part C, step 2 |

---

## Troubleshooting

- **`Missing required environment variable: X`** — that key is blank in
  `apps/watcher/.env`. Fill it and `pm2 restart slate-watcher`.
- **Watcher logs "No enabled channels configured"** — you haven't added a
  channel yet (Part J), or it's disabled. Add/enable one in Settings.
- **Settings page: "Failed to load Trello boards"** — `TRELLO_API_KEY` /
  `TRELLO_TOKEN` missing from the dashboard server env, or invalid. On Vercel,
  redeploy after adding them.
- **Settings page: board/list dropdowns empty** — the token may lack access to
  that board, or the board has no lists yet.
- **Dashboard shows "Supabase not configured"** — the `NEXT_PUBLIC_*` vars are
  missing or the dev server / Vercel wasn't restarted after adding them.
- **Card isn't picked up** — check `pm2 logs slate-watcher`. Confirm the channel
  is enabled and its **source list** matches the list you're adding cards to.
- **Reprocessing a card** — cards are de-duped by Supabase, so re-adding the same
  card won't re-run it (a new card is a new row, so a fresh card does run). To
  re-run a specific episode, delete its row from the `episodes` table in Supabase
  and the watcher will pick the card up again on the next poll.
- **Pipeline fails immediately** — confirm `curl -I http://localhost:7860`
  responds on the droplet and `gradio_client` is installed.
- **Drive upload fails** — make sure the target folder is **shared** with the
  service-account email and the JSON is valid one-line.
- **Deploying an update later**:
  ```bash
  cd /root/slate && git pull && pnpm --filter @slate/watcher build && pm2 restart slate-watcher
  ```
- **Disk usage** — `/tmp/gradio` auto-cleans at 3 AM UTC daily; check with `df -h`.
