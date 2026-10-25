import type { AssistantPhotoPort } from '../../application/assistant-images.js';
import { jsonRequest, jsonBody, boundedBody } from './http.js';

export class TelegramAssistantPhoto implements AssistantPhotoPort {
  constructor(private token: (id: string) => Promise<string | undefined>) {}
  async available(id: string) {
    return !!(await this.token(id));
  }
  private async call(token: string, method: string, body: unknown, signal: AbortSignal) {
    const result = await jsonRequest(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: 'POST',
        signal,
        ...(body instanceof FormData ? { body } : jsonBody(body)),
      },
      'Telegram',
    );
    if (!result?.ok) throw new Error('Telegram rejected the photo request');
    return result.result;
  }
  private async credential(id: string) {
    const token = await this.token(id);
    if (!token) throw new Error('Telegram connection is not configured for this assistant');
    return token;
  }
  async get(id: string, signal: AbortSignal) {
    const token = await this.credential(id);
    const me = await this.call(token, 'getMe', {}, signal);
    const photos = await this.call(
      token,
      'getUserProfilePhotos',
      { user_id: me.id, limit: 1 },
      signal,
    );
    const photo = photos?.photos?.[0]?.at(-1);
    if (!photo) return null;
    const file = await this.call(token, 'getFile', { file_id: photo.file_id }, signal);
    if (
      file.file_size > 524288 ||
      !/^photos\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/.test(file.file_path)
    )
      throw new Error('Telegram photo is too large or has an unsupported file path');
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
      signal,
      redirect: 'error',
    });
    if (!response.ok || !response.body) throw new Error('Telegram photo download failed');
    const bytes = await boundedBody(response, 524288);
    const mime =
      bytes[0] === 255 && bytes[1] === 216
        ? 'image/jpeg'
        : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ? 'image/png'
          : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
            ? 'image/webp'
            : '';
    if (!mime) throw new Error('Telegram returned an unsupported image');
    return `data:${mime};base64,${bytes.toString('base64')}`;
  }
  async set(id: string, jpeg: Uint8Array, signal: AbortSignal) {
    const token = await this.credential(id);
    const form = new FormData();
    form.set('photo', JSON.stringify({ type: 'static', photo: 'attach://photo_file' }));
    form.set(
      'photo_file',
      new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }),
      'assistant.jpg',
    );
    if ((await this.call(token, 'setMyProfilePhoto', form, signal)) !== true)
      throw new Error('Telegram did not confirm the photo update');
  }
}
