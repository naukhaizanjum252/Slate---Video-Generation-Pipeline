import axios from 'axios';
import { createLogger } from './logger';
import type { Config } from './config';

const log = createLogger('trello');
const API = 'https://api.trello.com/1';

export interface TrelloAttachment {
  id: string;
  url: string;
  name: string;
  mimeType: string | null;
  isUpload: boolean;
}

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  dateLastActivity: string;
  attachments: TrelloAttachment[];
}

export class TrelloClient {
  constructor(private readonly cfg: Config['trello']) {}

  private auth() {
    return { key: this.cfg.apiKey, token: this.cfg.token };
  }

  /**
   * Fetch all cards in a given list, including attachments so we can grab the
   * reference image without a second round trip. Called once per channel's
   * queue list each poll cycle.
   */
  async getCardsInList(listId: string): Promise<TrelloCard[]> {
    const url = `${API}/lists/${listId}/cards`;
    const { data } = await axios.get<TrelloCard[]>(url, {
      params: { ...this.auth(), attachments: 'true', fields: 'name,desc,dateLastActivity' },
      timeout: 30_000,
    });
    return data;
  }

  /**
   * Return the URL of the first image attachment on a card, or null.
   * Trello-hosted uploads require the API key/token to download, so we
   * surface both the URL and whether it's an upload.
   */
  firstImageAttachment(card: TrelloCard): TrelloAttachment | null {
    if (!card.attachments || card.attachments.length === 0) return null;
    const image =
      card.attachments.find((a) => (a.mimeType ?? '').startsWith('image/')) ??
      card.attachments.find((a) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(a.url)) ??
      card.attachments[0];
    return image ?? null;
  }

  /**
   * Download an attachment to the given destination path. For Trello-hosted
   * uploads we must send the auth header; external URLs are fetched plainly.
   */
  async downloadAttachment(att: TrelloAttachment, destPath: string): Promise<void> {
    const fs = await import('fs');
    const headers: Record<string, string> = {};
    if (att.isUpload && att.url.includes('trello.com')) {
      headers.Authorization = `OAuth oauth_consumer_key="${this.cfg.apiKey}", oauth_token="${this.cfg.token}"`;
    }
    const response = await axios.get(att.url, {
      responseType: 'stream',
      timeout: 60_000,
      headers,
      maxRedirects: 5,
    });
    await new Promise<void>((resolve, reject) => {
      const writer = fs.createWriteStream(destPath);
      response.data.pipe(writer);
      writer.on('finish', () => resolve());
      writer.on('error', reject);
      response.data.on('error', reject);
    });
    log.info(`Downloaded attachment "${att.name}" -> ${destPath}`);
  }
}
