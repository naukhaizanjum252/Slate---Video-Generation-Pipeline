import * as path from 'path';
import * as dotenv from 'dotenv';

// Load apps/watcher/.env regardless of where the process is launched from.
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Copy apps/watcher/.env.example to apps/watcher/.env and fill it in.`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export interface Config {
  trello: {
    apiKey: string;
    token: string;
  };
  gradio: {
    baseUrl: string;
  };
  supabase: {
    url: string;
    serviceRoleKey: string;
  };
  google: {
    // OAuth user credentials — uploads run as the real account that owns the
    // Drive folder. (Service accounts have no storage quota on personal Gmail.)
    oauthClientId: string;
    oauthClientSecret: string;
    oauthRefreshToken: string;
  };
  pythonBin: string;
  pollCron: string;
  // When false (default) the pipeline stops after producing the asset bundle
  // and skips the final /cb_build_video step. Flip on later to render video.
  enableBuildVideo: boolean;
}

let cached: Config | null = null;

/**
 * Validates and returns the runtime config. Throws a descriptive error
 * on the first missing variable so misconfiguration fails fast at boot.
 */
export function loadConfig(): Config {
  if (cached) return cached;
  cached = {
    trello: {
      apiKey: required('TRELLO_API_KEY'),
      token: required('TRELLO_TOKEN'),
    },
    gradio: {
      baseUrl: optional('GRADIO_BASE_URL', 'http://localhost:7860'),
    },
    supabase: {
      url: required('SUPABASE_URL'),
      serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    },
    google: {
      oauthClientId: required('GOOGLE_OAUTH_CLIENT_ID'),
      oauthClientSecret: required('GOOGLE_OAUTH_CLIENT_SECRET'),
      oauthRefreshToken: required('GOOGLE_OAUTH_REFRESH_TOKEN'),
    },
    pythonBin: optional('PYTHON_BIN', 'python3'),
    pollCron: optional('POLL_CRON', '*/60 * * * * *'),
    enableBuildVideo: bool('ENABLE_BUILD_VIDEO', false),
  };
  return cached;
}
