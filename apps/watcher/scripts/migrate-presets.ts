/**
 * One-time migration: copy presets from the old local file (intro-presets.json)
 * into the Supabase `intro_presets` table. Idempotent — skips any preset whose
 * name already exists. Run once after moving presets to Supabase:
 *   pnpm --filter @slate/watcher migrate-presets
 */
import './loadEnv'; // loads apps/watcher/.env (SUPABASE_URL / SERVICE_ROLE_KEY)
import * as fs from 'fs';
import * as path from 'path';
import ws from 'ws';
import { EpisodeStore } from '../src/supabase';

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in apps/watcher/.env');
    process.exit(1);
  }
  if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
    (globalThis as { WebSocket?: unknown }).WebSocket = ws;
  }
  const store = new EpisodeStore({ url, serviceRoleKey });

  const file = path.resolve(__dirname, '..', 'intro-presets.json');
  if (!fs.existsSync(file)) {
    console.log('No intro-presets.json found — nothing to migrate.');
    return;
  }
  const old = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{
    name: string;
    channel?: string;
    params: Record<string, unknown>;
  }>;
  const have = new Set((await store.listIntroPresets()).map((p) => p.name));
  let migrated = 0;
  for (const p of old) {
    if (have.has(p.name)) {
      console.log(`• skip "${p.name}" (already in Supabase)`);
      continue;
    }
    await store.createIntroPreset({ name: p.name, channel: p.channel ?? '', params: p.params });
    console.log(`✓ migrated "${p.name}"`);
    migrated++;
  }
  const total = (await store.listIntroPresets()).length;
  console.log(`Done. Migrated ${migrated}. Total presets in Supabase: ${total}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
