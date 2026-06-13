import type { DriveFolderOption } from '@slate/shared';

// Server-only Google Drive OAuth + REST helpers. Credentials stay on the server;
// the browser only ever triggers a redirect or sees folder names + IDs via the
// /api/drive/* routes. Uses plain fetch (no googleapis dependency in the dashboard).
//
// The same GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET the watcher uses,
// but the dashboard's client must be a "Web application" OAuth client with this
// app's callback registered as an authorized redirect URI.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

// Scopes: full Drive (create folders + upload), plus email/openid so we can show
// which account is connected.
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive'];

export const OAUTH_CALLBACK_PATH = '/api/drive/oauth/callback';

function creds(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET in the dashboard server env.',
    );
  }
  return { clientId, clientSecret };
}

/**
 * The redirect URI Google sends the user back to. Must EXACTLY match an
 * authorized redirect URI on the Web OAuth client. Defaults to `${origin}` +
 * the callback path; override with GOOGLE_OAUTH_REDIRECT_URI if behind a proxy
 * / custom domain where the request origin differs from the public URL.
 */
export function redirectUri(origin: string): string {
  const override = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  return override || `${origin}${OAUTH_CALLBACK_PATH}`;
}

/** Build the Google consent-screen URL to redirect the user to. */
export function buildAuthUrl(origin: string): string {
  const { clientId } = creds();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline', // request a refresh token
    prompt: 'consent', // force a refresh token even on repeat connects
    include_granted_scopes: 'true',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

/** Exchange an auth code for tokens (incl. the long-lived refresh token). */
export async function exchangeCode(code: string, origin: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = creds();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri(origin),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

/** Mint a short-lived access token from a stored refresh token. */
export async function accessTokenFromRefresh(refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = creds();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token refresh failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

/** Look up the connected account's email for display. */
export async function fetchAccountEmail(accessToken: string): Promise<string | null> {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { email?: string };
  return data.email ?? null;
}

/**
 * List folders the connected account can write to, for the channel folder
 * dropdown. Returns up to 1000 non-trashed folders, name-sorted. Spans My Drive
 * and any shared drives the account belongs to.
 */
export async function listFolders(refreshToken: string): Promise<DriveFolderOption[]> {
  const accessToken = await accessTokenFromRefresh(refreshToken);
  const params = new URLSearchParams({
    q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    fields: 'files(id,name)',
    orderBy: 'name',
    pageSize: '1000',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    corpora: 'allDrives',
  });
  const res = await fetch(`${DRIVE_FILES_URL}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Drive folder list failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { files?: Array<{ id: string; name: string }> };
  return (data.files ?? []).map((f) => ({ id: f.id, name: f.name }));
}
