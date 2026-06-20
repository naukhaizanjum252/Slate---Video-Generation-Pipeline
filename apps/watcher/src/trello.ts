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

  /** Move a card to another list (used to move to the resolve list on done). */
  async moveCard(cardId: string, listId: string): Promise<void> {
    const url = `${API}/cards/${cardId}`;
    await axios.put(url, null, {
      params: { ...this.auth(), idList: listId },
      timeout: 30_000,
    });
    log.info(`Moved card ${cardId} -> list ${listId}`);
  }

  /** Add a comment to a card (used to post the Drive folder link on done). */
  async addComment(cardId: string, text: string): Promise<void> {
    const url = `${API}/cards/${cardId}/actions/comments`;
    await axios.post(url, null, {
      params: { ...this.auth(), text },
      timeout: 30_000,
    });
    log.info(`Commented on card ${cardId}`);
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
   * Return the first VIDEO attachment on a card (the intro clip for video mode),
   * or null. Matches by mime type first, then by common video extensions.
   */
  firstVideoAttachment(card: TrelloCard): TrelloAttachment | null {
    if (!card.attachments || card.attachments.length === 0) return null;
    const video =
      card.attachments.find((a) => (a.mimeType ?? '').startsWith('video/')) ??
      card.attachments.find((a) => /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(a.url));
    return video ?? null;
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
