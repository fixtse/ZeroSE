import type { Config } from '../../domain/config.js';

export function homeAssistantCommand(
  config: Config['homeAssistant'],
  command: Record<string, unknown>,
  signal: AbortSignal,
): Promise<any> {
  signal.throwIfAborted();
  const url = new URL(config.url.replace(/\/$/, '') + '/api/websocket');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      socket.onclose = socket.onerror = socket.onmessage = null;
      socket.close();
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new Error('Home Assistant request cancelled'));
    const timer = setTimeout(() => finish(new Error('Home Assistant request timed out')), 15_000);
    signal.addEventListener('abort', abort, { once: true });
    socket.onerror = () => finish(new Error('Home Assistant connection failed'));
    socket.onclose = () => finish(new Error('Home Assistant connection closed'));
    socket.onmessage = (event) => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 2_000_000)
          throw new Error('Invalid Home Assistant catalog');
        const message = JSON.parse(event.data);
        if (message.type === 'auth_required')
          socket.send(JSON.stringify({ type: 'auth', access_token: config.token }));
        else if (message.type === 'auth_ok') socket.send(JSON.stringify({ id: 1, ...command }));
        else if (message.type === 'auth_invalid')
          finish(new Error('Home Assistant authentication failed'));
        else if (message.type === 'result' && message.id === 1) {
          if (!message.success) {
            const errors: Record<string, string> = {
              admin_required:
                'Un administrador de Home Assistant debe exponer estas entidades a Assist.',
              location_unavailable:
                'La ubicación no existe o el usuario de Home Assistant no tiene permiso para leerla.',
            };
            finish(
              new Error(
                errors[message.error?.code] ||
                  'Home Assistant command is unavailable; inspect before retrying',
              ),
            );
          } else finish(undefined, message.result);
        }
      } catch {
        finish(new Error('Home Assistant returned an invalid response'));
      }
    };
  });
}
