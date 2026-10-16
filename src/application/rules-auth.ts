import { createHmac } from 'node:crypto';
/** Separate bearer credential: HA can trigger evaluation but cannot use the admin/chat API. */
export function rulesToken(apiKey: string) {
  return createHmac('sha256', apiKey).update('assistant-rules-heartbeat-v1').digest('hex');
}
