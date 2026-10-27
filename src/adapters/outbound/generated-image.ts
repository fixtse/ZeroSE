import type { GeneratedImage } from '../../domain/models.js';

/** Decode only event payloads, never a model-supplied URL or local file path. */
export function generatedImage(result: unknown, maxBytes: number): GeneratedImage {
  if (typeof result !== 'string' || !result.length || result.length > Math.ceil(maxBytes / 3) * 4)
    throw new Error('Generated image is empty or exceeds the configured size limit');
  if (result.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result))
    throw new Error('Invalid generated image encoding');
  const data = Buffer.from(result, 'base64');
  if (!data.length || data.length > maxBytes)
    throw new Error('Generated image exceeds the configured size limit');
  const mimeType = data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    ? 'image/png'
    : data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      ? 'image/jpeg'
      : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
        ? 'image/webp'
        : ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))
          ? 'image/gif'
          : undefined;
  if (!mimeType) throw new Error('Unsupported generated image format');
  return { data, mimeType };
}
