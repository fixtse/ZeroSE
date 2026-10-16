import { createHmac } from 'node:crypto';
/** Separate bearer credential: HA can deliver rule events but cannot use the admin/chat API. */
export function rulesToken(apiKey: string) {
  return createHmac('sha256', apiKey).update('assistant-rule-events-v2').digest('hex');
}
