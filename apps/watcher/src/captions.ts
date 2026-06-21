/**
 * Auto-generate an SRT from a voiceover via the OpenAI transcription API (Whisper).
 * Shared by the editor and the watcher pipeline. Needs OPENAI_API_KEY; returns null
 * gracefully if unset or on error (so captions just don't burn in). No local install.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createLogger } from './logger';

const log = createLogger('captions');

export async function autoCaptionSrt(voiceoverPath: string, outDir: string): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    log.warn('No OPENAI_API_KEY set — skipping auto-captions (provide an SRT instead).');
    return null;
  }
  try {
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(voiceoverPath)]), path.basename(voiceoverPath));
    fd.append('model', process.env.OPENAI_STT_MODEL || 'whisper-1');
    fd.append('response_format', 'srt');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
    });
    if (!res.ok) {
      log.warn(`OpenAI transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    const srt = await res.text();
    const out = path.join(outDir, `auto-${crypto.randomUUID()}.srt`);
    fs.writeFileSync(out, srt);
    return out;
  } catch (err) {
    log.warn('Auto-caption (OpenAI) failed', err);
    return null;
  }
}
