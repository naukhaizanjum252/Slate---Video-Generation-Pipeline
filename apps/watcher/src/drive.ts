import * as fs from 'fs';
import * as path from 'path';
import { google, drive_v3, type Auth } from 'googleapis';
import { createLogger } from './logger';
import type { Config } from './config';

const log = createLogger('drive');

/**
 * Resolves the current Drive refresh token at upload time. Lets the connected
 * account be switched from the dashboard (stored in Supabase) without a restart.
 */
export type RefreshTokenProvider = () => Promise<string>;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.srt': 'application/x-subrip',
};

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function mimeForFile(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export class DriveUploader {
  private readonly oauth2: Auth.OAuth2Client;
  private readonly drive: drive_v3.Drive;
  private currentToken = '';

  constructor(
    cfg: Config['google'],
    private readonly getRefreshToken: RefreshTokenProvider,
  ) {
    // OAuth as the real Drive owner. googleapis auto-refreshes the access token
    // from the refresh token, so this works unattended on the server. The
    // refresh token is resolved per upload (see ensureAuth) so the dashboard can
    // switch accounts without a redeploy.
    this.oauth2 = new google.auth.OAuth2(cfg.oauthClientId, cfg.oauthClientSecret);
    this.drive = google.drive({ version: 'v3', auth: this.oauth2 });
  }

  /** Resolve the current refresh token and apply it to the OAuth client. */
  private async ensureAuth(): Promise<void> {
    const token = (await this.getRefreshToken()).trim();
    if (!token) {
      throw new Error(
        'No Google Drive account connected. Connect one in the dashboard Settings ' +
          '(or set GOOGLE_OAUTH_REFRESH_TOKEN in the watcher env).',
      );
    }
    // Only reset credentials when the token actually changed, so we don't throw
    // away a cached access token on every upload.
    if (token !== this.currentToken) {
      this.oauth2.setCredentials({ refresh_token: token });
      this.currentToken = token;
    }
  }

  /** Create a folder under the given parent and return its id. */
  private async createFolder(name: string, parentId: string): Promise<string> {
    const res = await this.drive.files.create({
      requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
      fields: 'id',
      supportsAllDrives: true,
    });
    const id = res.data.id;
    if (!id) throw new Error(`Drive folder creation returned no id for "${name}"`);
    return id;
  }

  /**
   * Create a subfolder named `folderName` under the channel's Drive folder, upload
   * the file into it, make the folder link-viewable, and return the folder URL.
   * Used for the edited intro so it lands in a per-episode folder (like episodes).
   */
  async uploadFileToNewFolder(filePath: string, folderName: string, parentFolderId: string): Promise<string> {
    const parent = (parentFolderId ?? '').trim();
    if (!parent) {
      throw new Error('No Drive folder configured for this channel. Pick one in Settings.');
    }
    await this.ensureAuth();
    const folderId = await this.createFolder(folderName, parent);
    await this.uploadFile(filePath, folderId);
    await this.setPublicRead(folderId);
    const url = `https://drive.google.com/drive/folders/${folderId}`;
    log.info(`Uploaded ${path.basename(filePath)} -> ${url}`);
    return url;
  }

  private async uploadFile(filePath: string, parentId: string): Promise<void> {
    const name = path.basename(filePath);
    await this.drive.files.create({
      requestBody: { name, parents: [parentId] },
      media: { mimeType: mimeForFile(filePath), body: fs.createReadStream(filePath) },
      fields: 'id',
      supportsAllDrives: true,
    });
  }

  private async setPublicRead(fileId: string): Promise<void> {
    await this.drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true,
    });
  }

  /**
   * Recursively upload the contents of localDir into a Drive folder,
   * preserving subfolder structure (e.g. images/, audio/).
   */
  private async uploadDirContents(localDir: string, driveFolderId: string): Promise<void> {
    const entries = fs.readdirSync(localDir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(localDir, entry.name);
      if (entry.isDirectory()) {
        const subId = await this.createFolder(entry.name, driveFolderId);
        await this.uploadDirContents(full, subId);
      } else if (entry.isFile()) {
        await this.uploadFile(full, driveFolderId);
      }
    }
  }

  /**
   * Create a folder named `cardTitle` inside the channel's Drive folder, upload
   * the full unzipped bundle (preserving structure), make it link-viewable, and
   * return the shareable folder URL.
   *
   * @param parentFolderId the channel's Drive folder ID (mandatory).
   */
  async uploadEpisodeFolder(
    cardTitle: string,
    unzippedDir: string,
    parentFolderId: string,
  ): Promise<string> {
    const parent = (parentFolderId ?? '').trim();
    if (!parent) {
      throw new Error(
        'No Drive folder configured for this channel. Pick a Drive folder in the dashboard Settings.',
      );
    }
    await this.ensureAuth();
    const folderId = await this.createFolder(cardTitle, parent);
    log.info(`Created Drive folder "${cardTitle}" (${folderId}) under parent ${parent}`);
    await this.uploadDirContents(unzippedDir, folderId);
    await this.setPublicRead(folderId);
    const url = `https://drive.google.com/drive/folders/${folderId}`;
    log.info(`Uploaded episode bundle -> ${url}`);
    return url;
  }

  /**
   * Recursively download a Drive folder's contents into `destDir`, preserving structure.
   * `opts.skipExt` (lowercase, with dot) skips matching files — e.g. skip prior MP4s
   * (test edits / the final video) that the body build doesn't need.
   */
  async downloadFolderContents(folderId: string, destDir: string, opts?: { skipExt?: string[] }): Promise<void> {
    await this.ensureAuth();
    fs.mkdirSync(destDir, { recursive: true });
    const skip = new Set((opts?.skipExt ?? []).map((e) => e.toLowerCase()));
    let pageToken: string | undefined;
    do {
      const res = await this.drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType)',
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      for (const f of res.data.files ?? []) {
        if (!f.id || !f.name) continue;
        const dest = path.join(destDir, f.name);
        if (f.mimeType === FOLDER_MIME) await this.downloadFolderContents(f.id, dest, opts);
        else if (!skip.has(path.extname(f.name).toLowerCase())) await this.downloadFile(f.id, dest);
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  private async downloadFile(fileId: string, dest: string): Promise<void> {
    const res = await this.drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' },
    );
    await new Promise<void>((resolve, reject) => {
      const w = fs.createWriteStream(dest);
      const stream = res.data as NodeJS.ReadableStream;
      stream.pipe(w);
      w.on('finish', () => resolve());
      w.on('error', reject);
      stream.on('error', reject);
    });
  }

  /** Upload one file into an existing Drive folder, make it readable, return the folder URL. */
  async uploadFileIntoFolder(filePath: string, folderId: string): Promise<string> {
    await this.ensureAuth();
    const res = await this.drive.files.create({
      requestBody: { name: path.basename(filePath), parents: [folderId] },
      media: { mimeType: mimeForFile(filePath), body: fs.createReadStream(filePath) },
      fields: 'id',
      supportsAllDrives: true,
    });
    if (res.data.id) await this.setPublicRead(res.data.id);
    const url = `https://drive.google.com/drive/folders/${folderId}`;
    log.info(`Uploaded ${path.basename(filePath)} into folder ${folderId}`);
    return url;
  }
}

/** Extract a Drive folder id from a folder URL (or pass through an id). */
export function parseDriveFolderId(urlOrId: string | null | undefined): string | null {
  if (!urlOrId) return null;
  const m = urlOrId.match(/folders\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  const t = urlOrId.trim();
  return /^[A-Za-z0-9_-]{10,}$/.test(t) ? t : null;
}
