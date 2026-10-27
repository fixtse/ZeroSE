import type { Config } from '../src/domain/config.js';

/** Installation helper. Mutations are sent once; uncertain results are never replayed. */
export async function connectHomeAssistant(config: Config) {
  const url = new URL(config.homeAssistant.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/websocket';
  const socket = new WebSocket(url);
  let id = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('HA authentication timed out'));
    }, 10000);
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'auth_required')
        socket.send(JSON.stringify({ type: 'auth', access_token: config.homeAssistant.token }));
      if (message.type === 'auth_ok') {
        clearTimeout(timeout);
        resolve();
      }
      if (message.type === 'auth_invalid') {
        clearTimeout(timeout);
        socket.close();
        reject(new Error('HA authentication failed'));
      }
      if (message.type === 'result') {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.success) request?.resolve(message.result);
        else
          request?.reject(new Error('HA command rejected: ' + (message.error?.code || 'unknown')));
      }
    });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('HA WebSocket failed'));
    });
    socket.addEventListener('close', () => {
      clearTimeout(timeout);
      reject(new Error('HA WebSocket closed'));
      for (const request of pending.values())
        request.reject(new Error('HA disconnected; command outcome uncertain'));
      pending.clear();
    });
  });
  return {
    command(type: string, data: Record<string, unknown> = {}): Promise<any> {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error('HA command timed out; inspect before retrying'));
        }, 15000);
        pending.set(requestId, {
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
        socket.send(JSON.stringify({ id: requestId, type, ...data }));
      });
    },
    close() {
      socket.close();
    },
  };
}
