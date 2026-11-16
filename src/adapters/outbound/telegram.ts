import type { GeneratedImage } from '../../domain/models.js';
import { Config } from '../../domain/config.js';
import { Media } from './media.js';
import { jsonRequest, RemoteError } from './http.js';
import { TranscriptionUnavailableError } from './transcription-pool.js';
import telegramifyMarkdown from 'telegramify-markdown';

export function chunks(text: string, limit = 3900): string[] {
  if (limit < 2) throw new Error('Chunk size must allow a complete Unicode character');
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      if (/^[\uD800-\uDBFF]$/.test(text[end - 1])) end--;
      const space = text.lastIndexOf(' ', end);
      if (space > start + limit / 2) end = space;
    }
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}
export class Telegram {
  constructor(
    private config: Config,
    private media: Media,
    private identity = 'Zero',
  ) {}
  async call(method: string, body: any, signal?: AbortSignal): Promise<any> {
    if (!this.config.telegram.token) throw new Error('Telegram bot token is not configured');
    const form = body instanceof FormData;
    const result = await jsonRequest(
      `https://api.telegram.org/bot${this.config.telegram.token}/${method}`,
      {
        method: 'POST',
        signal,
        ...(form
          ? { body }
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      },
      'Telegram',
    );
    if (!result.ok) throw new Error('Telegram rejected the request');
    return result.result;
  }
  async profilePhoto(chatId: string): Promise<string | undefined> {
    const signal = AbortSignal.timeout(10000);
    const photo =
      Number(chatId) < 0
        ? (await this.call('getChat', { chat_id: chatId }, signal)).photo
        : (await this.call('getUserProfilePhotos', { user_id: Number(chatId), limit: 1 }, signal))
            .photos?.[0]?.[0];
    const fileId = Number(chatId) < 0 ? photo?.small_file_id : photo?.file_id;
    if (!fileId || photo.file_size > 1024 * 1024) return;
    const info = await this.call('getFile', { file_id: fileId }, signal);
    const buffer = await this.media.download(
      `https://api.telegram.org/file/bot${this.config.telegram.token}/${info.file_path}`,
      signal,
    );
    if (buffer.length > 1024 * 1024) return;
    return 'data:image/jpeg;base64,' + buffer.toString('base64');
  }
  async send(
    chat: string,
    text: string,
    signal?: AbortSignal,
    replyTo?: number,
    choices?: string[],
  ) {
    for (const chunk of chunks(text)) {
      const body = {
        chat_id: chat,
        ...(choices
          ? {
              reply_markup: choices.length
                ? {
                    keyboard: choices.map((text) => [{ text }]),
                    resize_keyboard: true,
                    one_time_keyboard: true,
                    selective: true,
                  }
                : { remove_keyboard: true, selective: true },
            }
          : {}),
        ...(replyTo
          ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
          : {}),
      };
      let formatted = '';
      try {
        formatted = telegramifyMarkdown(chunk, 'escape');
      } catch {
        /* send plain text below */
      }
      if (!formatted || formatted.length > 4000) {
        await this.call('sendMessage', { ...body, text: chunk }, signal);
        continue;
      }
      try {
        await this.call(
          'sendMessage',
          { ...body, text: formatted, parse_mode: 'MarkdownV2' },
          signal,
        );
      } catch (error) {
        if (!(error instanceof RemoteError) || error.status !== 400) throw error;
        await this.call('sendMessage', { ...body, text: chunk }, signal);
      }
    }
  }
  async sendImage(chat: string, image: GeneratedImage, signal: AbortSignal, replyTo?: number) {
    signal.throwIfAborted();
    if (!image.data.length || image.data.length > Math.min(this.config.media.maxBytes, 50_000_000))
      throw new Error('Generated image exceeds the configured size limit or is empty');
    const extensions = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
    };
    const extension = extensions[image.mimeType];
    if (!extension) throw new Error('Unsupported generated image format');
    const form = new FormData();
    form.set('chat_id', chat);
    // Documents preserve original quality, transparency and formats such as WebP.
    form.set(
      'document',
      new Blob([new Uint8Array(image.data)], { type: image.mimeType }),
      `image.${extension}`,
    );
    if (replyTo)
      form.set(
        'reply_parameters',
        JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }),
      );
    await this.call('sendDocument', form, signal);
  }
  async sendVoice(chat: string, text: string, job: string, signal: AbortSignal) {
    const buffer = await this.media.voice(text, job, signal),
      form = new FormData();
    form.set('chat_id', chat);
    form.set('voice', new Blob([new Uint8Array(buffer)], { type: 'audio/ogg' }), 'voice.ogg');
    await this.call('sendVoice', form, signal);
  }
  typing(chat: string, signal?: AbortSignal) {
    return this.call('sendChatAction', { chat_id: chat, action: 'typing' }, signal);
  }
  async input(
    message: any,
    job: string,
    signal: AbortSignal,
  ): Promise<{
    text: string;
    images: string[];
    transcriptionOnly: boolean;
    serviceReply?: string;
  }> {
    if (
      ['group', 'supergroup'].includes(message.chat?.type) &&
      (message.group_chat_created ||
        message.supergroup_chat_created ||
        message.new_chat_members?.length)
    ) {
      let joined = !!(message.group_chat_created || message.supergroup_chat_created);
      if (!joined) {
        const me = await this.call('getMe', {}, signal);
        joined = message.new_chat_members.some((member: { id: number }) => member.id === me.id);
      }
      return {
        text: '',
        images: [],
        transcriptionOnly: false,
        serviceReply: joined
          ? `¡Hola! Soy ${this.identity}, vuestro asistente. Gracias por añadirme al grupo.\n\nChat ID: ${message.chat.id}`
          : '',
      };
    }
    const reply = message.reply_to_message || message.external_reply;
    const repliedMedia = reply && (reply.voice || reply.audio || reply.video_note || reply.video);
    const source = repliedMedia ? reply : message;
    const media =
      source.voice ||
      source.audio ||
      source.video_note ||
      source.video ||
      source.photo?.at(-1) ||
      source.document;
    const ownText = message.text || message.caption || '';
    if (!media)
      return {
        text: reply?.text
          ? `Message being replied to:\n${reply.text}\n\nUser request:\n${ownText}`
          : ownText,
        images: [],
        transcriptionOnly: false,
      };
    if (media.file_size > this.config.media.maxBytes)
      throw new Error('Attachment exceeds the configured size limit');
    const info = await this.call('getFile', { file_id: media.file_id }, signal);
    const buffer = await this.media.download(
      `https://api.telegram.org/file/bot${this.config.telegram.token}/${info.file_path}`,
      signal,
    );
    const mime =
      media.mime_type ||
      (source.photo
        ? 'image/jpeg'
        : source.video_note || source.video
          ? 'video/mp4'
          : source.voice
            ? 'audio/ogg'
            : source.audio
              ? 'audio/mpeg'
              : 'application/octet-stream');
    const forwarded = !!(
      source.forward_origin ||
      source.forward_date ||
      source.forward_from ||
      source.forward_from_chat ||
      source.forward_sender_name
    );
    const transcriptionOnly =
      !!repliedMedia || mime.startsWith('video/') || (forwarded && mime.startsWith('audio/'));
    let result: { text: string; images: string[] };
    try {
      result = await this.media.extract(
        buffer,
        media.file_name || info.file_path,
        mime,
        job,
        signal,
      );
    } catch (error) {
      if (!(error instanceof TranscriptionUnavailableError)) throw error;
      // Without a speech-to-text service, explain instead of failing the job.
      return {
        text: '',
        images: [],
        transcriptionOnly: true,
        serviceReply: ownText
          ? 'No puedo escuchar audios todavía: la transcripción no está configurada. He ignorado el adjunto; escríbeme el mensaje.'
          : 'No puedo escuchar audios todavía: la transcripción de voz no está configurada. Pide a la persona administradora que la active en Ajustes → Vídeo y voz, o escríbeme el mensaje.',
      };
    }
    if (result.text.length > 150_000)
      throw new Error('Extracted content is too large for one message');
    return {
      ...result,
      text: [transcriptionOnly ? '' : ownText, result.text].filter(Boolean).join('\n\n'),
      transcriptionOnly,
    };
  }
}
