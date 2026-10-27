export class RemoteError extends Error {
  constructor(
    public service: string,
    public status: number,
  ) {
    super(`${service} returned HTTP ${status}`);
  }
}
export async function jsonRequest(
  url: string | URL,
  options: RequestInit = {},
  service = 'Remote service',
): Promise<any> {
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: options.signal || AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new RemoteError(service, response.status);
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
export const jsonBody = (value: unknown) => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(value),
});
export async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok) throw new Error(`Download returned HTTP ${response.status}`);
  if (Number(response.headers.get('content-length') || 0) > limit) {
    await response.body?.cancel();
    throw new Error('File exceeds size limit');
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('File exceeds size limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
