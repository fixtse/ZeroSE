import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { EdgeTTS } from 'node-edge-tts';
import { Config } from '../../domain/config.js';
import { jsonRequest, boundedBody, RemoteError } from './http.js';

const exec = promisify(execFile);
export class Media {
  constructor(private config: Config) {}
  directory(job: string) {
    return join(this.config.dataDir, 'media', job);
  }
  async cleanup(job: string) {
    await rm(this.directory(job), { recursive: true, force: true });
  }
  async transcribe(buffer: Buffer, mime: string, signal: AbortSignal): Promise<string> {
    if (!this.config.media.asrUrl)
      throw new Error('Speech transcription endpoint is not configured');
    const form = new FormData();
    form.set('audio_file', new Blob([new Uint8Array(buffer)], { type: mime }), 'audio.wav');
    const result = await jsonRequest(
      this.config.media.asrUrl,
      { method: 'POST', body: form, signal },
      'Speech transcription',
    );
    if (typeof result.text !== 'string') throw new Error('Transcription service returned no text');
    return result.text;
  }
  async extract(
    buffer: Buffer,
    filename: string,
    mime: string,
    job: string,
    signal: AbortSignal,
  ): Promise<{ text: string; images: string[] }> {
    const dir = this.directory(job);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const extension = extname(filename).toLowerCase();
    if (mime.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.webp'].includes(extension)) {
      const file = join(
        dir,
        'image' + (['.jpg', '.jpeg', '.png', '.webp'].includes(extension) ? extension : '.png'),
      );
      await writeFile(file, buffer, { mode: 0o600 });
      return {
        text: 'Interpret the attached image in the context of the user request.',
        images: [file],
      };
    }
    if (mime.startsWith('audio/'))
      return { text: await this.transcribe(buffer, mime, signal), images: [] };
    if (mime.startsWith('video/')) {
      if (this.config.media.audioExtractionUrl) {
        const form = new FormData();
        form.set('file', new Blob([new Uint8Array(buffer)], { type: mime }), filename);
        const response = await fetch(this.config.media.audioExtractionUrl, {
          method: 'POST',
          body: form,
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        });
        if (!response.ok) throw new RemoteError('Audio extraction', response.status);
        const audio = await boundedBody(response, this.config.media.maxBytes);
        if (!audio.length) throw new Error('Audio extraction service returned no audio');
        return { text: await this.transcribe(audio, 'audio/wav', signal), images: [] };
      }
      const source = join(dir, 'video'),
        audio = join(dir, 'audio.wav');
      await writeFile(source, buffer, { mode: 0o600 });
      await exec(
        'ffmpeg',
        ['-nostdin', '-y', '-i', source, '-vn', '-ac', '1', '-ar', '16000', audio],
        { timeout: 60_000, signal, maxBuffer: 1_000_000 },
      );
      return {
        text: await this.transcribe(await readFile(audio), 'audio/wav', signal),
        images: [],
      };
    }
    if (extension === '.pdf' || mime === 'application/pdf') {
      const source = join(dir, 'document.pdf');
      await writeFile(source, buffer, { mode: 0o600 });
      const { stdout } = await exec('pdftotext', ['-layout', source, '-'], {
        timeout: 30_000,
        signal,
        maxBuffer: 2_000_000,
      });
      if (!stdout.trim())
        throw new Error('PDF has no extractable text; send scanned pages as images');
      return { text: stdout, images: [] };
    }
    if (extension === '.xls' || extension === '.doc') {
      const source = join(dir, 'document' + extension);
      await writeFile(source, buffer, { mode: 0o600 });
      const { stdout } = await exec(extension === '.xls' ? 'xls2csv' : 'catdoc', [source], {
        timeout: 30_000,
        signal,
        maxBuffer: 2_000_000,
      });
      return { text: stdout, images: [] };
    }
    if (extension === '.docx')
      return { text: (await mammoth.extractRawText({ buffer })).value, images: [] };
    if (extension === '.xlsx') {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as any);
      const lines: string[] = [];
      workbook.eachSheet((sheet) => {
        lines.push(`Sheet: ${sheet.name}`);
        sheet.eachRow((row) => {
          lines.push(JSON.stringify(row.values));
        });
      });
      return { text: lines.join('\n'), images: [] };
    }
    if (
      mime.startsWith('text/') ||
      ['.txt', '.csv', '.tsv', '.md', '.json', '.xml'].includes(extension)
    )
      return { text: buffer.toString('utf8'), images: [] };
    throw new Error(`Unsupported document type: ${extension || mime}`);
  }
  async voice(text: string, job: string, signal: AbortSignal): Promise<Buffer> {
    const dir = this.directory(job);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const mp3 = join(dir, 'speech.mp3'),
      ogg = join(dir, 'speech.ogg');
    const clean = text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[*_~#`]/g, '')
      .replace(/\p{Extended_Pictographic}/gu, '')
      .trim();
    await new EdgeTTS({
      voice: this.config.media.voice,
      lang: 'es-ES',
      timeout: 30_000,
    }).ttsPromise(clean, mp3);
    signal.throwIfAborted();
    await exec('ffmpeg', ['-nostdin', '-y', '-i', mp3, '-c:a', 'libopus', ogg], {
      timeout: 30_000,
      signal,
      maxBuffer: 1_000_000,
    });
    return readFile(ogg);
  }
  async download(url: string, signal: AbortSignal) {
    return boundedBody(await fetch(url, { redirect: 'error', signal }), this.config.media.maxBytes);
  }
}
