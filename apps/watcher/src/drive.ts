import * as fs from 'fs';
import * as path from 'path';
import { google, drive_v3 } from 'googleapis';
import { createLogger } from './logger';
import type { Config } from './config';

const log = createLogger('drive');

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
  private readonly drive: drive_v3.Drive;

  constructor(cfg: Config['google']) {
    // OAuth as the real Drive owner. googleapis auto-refreshes the access token
    // from the refresh token, so this works unattended on the server.
    const oauth2 = new google.auth.OAuth2(cfg.oauthClientId, cfg.oauthClientSecret);
    oauth2.setCredentials({ refresh_token: cfg.oauthRefreshToken });
    this.drive = google.drive({ version: 'v3', auth: oauth2 });
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
        'No Drive folder configured for this channel. Set a Drive folder ID in the dashboard Settings.',
      );
    }
    const folderId = await this.createFolder(cardTitle, parent);
    log.info(`Created Drive folder "${cardTitle}" (${folderId}) under parent ${parent}`);
    await this.uploadDirContents(unzippedDir, folderId);
    await this.setPublicRead(folderId);
    const url = `https://drive.google.com/drive/folders/${folderId}`;
    log.info(`Uploaded episode bundle -> ${url}`);
    return url;
  }
}
