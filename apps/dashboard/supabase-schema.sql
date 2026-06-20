-- Slate schema. Run this in the Supabase SQL editor.
-- Safe to re-run: everything is idempotent.

-- ─── Channels ──────────────────────────────────────────────────────────────
-- One row per YouTube channel. Holds the Trello board + the single SOURCE list
-- the watcher polls (managed from the dashboard's Settings page) and an optional
-- per-channel Drive folder. Cards are NOT moved between lists — status is
-- tracked in the episodes table / dashboard instead.
create table if not exists channels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  trello_board_id text not null,
  trello_source_list_id text not null,   -- watcher polls this list
  trello_resolve_list_id text not null,  -- card moved here on done (+ Drive comment)
  drive_folder_id text not null,         -- mandatory: each channel's own folder
  enabled boolean not null default true,
  created_at timestamptz default now()
);

-- Migrate an older 4-list schema if present: rename queue -> source and drop
-- the processing/done/failed columns. Safe no-ops on a fresh database.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'channels' and column_name = 'trello_queue_list_id'
  ) and not exists (
    select 1 from information_schema.columns
    where table_name = 'channels' and column_name = 'trello_source_list_id'
  ) then
    alter table channels rename column trello_queue_list_id to trello_source_list_id;
  end if;
  alter table channels drop column if exists trello_processing_list_id;
  alter table channels drop column if exists trello_done_list_id;
  alter table channels drop column if exists trello_failed_list_id;
  -- Make drive_folder_id mandatory. Backfill any existing NULLs to '' first so
  -- the constraint can apply; those channels must be edited in the dashboard to
  -- set a real folder (the watcher will error clearly until they do).
  if exists (
    select 1 from information_schema.columns
    where table_name = 'channels' and column_name = 'drive_folder_id'
      and is_nullable = 'YES'
  ) then
    update channels set drive_folder_id = '' where drive_folder_id is null;
    alter table channels alter column drive_folder_id set not null;
  end if;
  -- Add the resolve list (cards move here on done). Backfill existing rows to ''
  -- so NOT NULL applies; set the real list in the dashboard.
  alter table channels add column if not exists trello_resolve_list_id text;
  update channels set trello_resolve_list_id = '' where trello_resolve_list_id is null;
  alter table channels alter column trello_resolve_list_id set not null;
end $$;

create index if not exists channels_enabled_idx on channels(enabled);

-- ─── Episodes ──────────────────────────────────────────────────────────────
create table if not exists episodes (
  id uuid primary key default gen_random_uuid(),
  trello_card_id text unique not null,
  card_title text not null,
  episode_name text not null,
  status text not null default 'processing',
  drive_folder_url text,
  error_message text,
  created_at timestamptz default now(),
  completed_at timestamptz
);

-- Link episodes to the channel that produced them, plus the live pipeline stage
-- (added idempotently so this file is safe to run on an existing database).
-- Per-channel video mode. When true the watcher builds the full MP4 (effect +
-- boom + stitched intro) and uploads ONLY that video; when false (default) it
-- uploads the asset bundle as before. Added idempotently.
alter table channels add column if not exists video_mode boolean not null default false;

alter table episodes add column if not exists channel_id uuid references channels(id);
alter table episodes add column if not exists channel_name text;
alter table episodes add column if not exists stage text;
alter table episodes add column if not exists progress jsonb;
alter table episodes add column if not exists timeline jsonb;
alter table episodes add column if not exists cancel_requested boolean not null default false;

create index if not exists episodes_status_idx on episodes(status);
create index if not exists episodes_created_at_idx on episodes(created_at desc);
create index if not exists episodes_channel_idx on episodes(channel_id);

-- ─── Drive auth ─────────────────────────────────────────────────────────────
-- Holds the SINGLE connected Google account used for all Drive uploads. Set from
-- the dashboard's "Connect Google Drive" button (server-side, service-role) and
-- read by the watcher at upload time, so switching accounts needs no redeploy.
--
-- SECURITY: this table is NEVER exposed to the browser. It has RLS enabled with
-- NO anon policy, so only the service-role key (watcher + dashboard server) can
-- read or write it. The refresh_token must never reach the client.
--
-- Single-row pattern: the boolean primary key is forced to `true` by a check
-- constraint, so upserts on id=true always target the one row.
create table if not exists drive_auth (
  id boolean primary key default true,
  refresh_token text not null,
  account_email text,
  updated_at timestamptz default now(),
  constraint drive_auth_singleton check (id = true)
);

-- ─── Row Level Security ─────────────────────────────────────────────────────
-- The dashboard's anon key may READ episodes + channels only. drive_auth has RLS
-- on with NO policy → service-role only. All WRITES go through the dashboard's
-- server-side API routes / the watcher, both using the service-role key, which
-- bypasses RLS.
alter table episodes enable row level security;
alter table channels enable row level security;
alter table drive_auth enable row level security;

drop policy if exists "anon can read episodes" on episodes;
create policy "anon can read episodes"
  on episodes
  for select
  to anon
  using (true);

drop policy if exists "anon can read channels" on channels;
create policy "anon can read channels"
  on channels
  for select
  to anon
  using (true);
