/** Keep provider URLs, credentials, response bodies and arbitrary thrown values out of logs. */
export function deploymentNotificationError(error: unknown) {
  if (!(error instanceof Error)) return { type: 'unknown', message: 'Non-Error failure' };
  const type = ['Error', 'TypeError', 'TimeoutError', 'AbortError', 'SyntaxError'].includes(
    error.name,
  )
    ? error.name
    : 'Error';
  const status = 'status' in error ? error.status : undefined;
  const httpStatus =
    typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : undefined;
  const cause = error.cause;
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  const networkCode =
    typeof code === 'string' &&
    /^(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(
      code,
    )
      ? code
      : undefined;
  const knownMessages = [
    'Configured deployment notification bot is unavailable',
    'Telegram bot token is not configured',
    'Telegram rejected the request',
    'fetch failed',
  ];
  const message = httpStatus
    ? `Telegram returned HTTP ${httpStatus}`
    : knownMessages.includes(error.message)
      ? error.message
      : type === 'TimeoutError'
        ? 'Telegram notification timed out'
        : type === 'AbortError'
          ? 'Telegram notification aborted'
          : 'Notification failed; untrusted error details omitted';
  return { type, message, httpStatus, networkCode };
}
