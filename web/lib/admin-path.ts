/** Supervisor strips the Ingress prefix before forwarding requests to Zero. */
export function adminPath(path: string) {
  if (typeof window === 'undefined') return path;
  const prefix =
    /^\/api\/hassio_ingress\/[a-zA-Z0-9_-]+(?=\/)/.exec(window.location.pathname)?.[0] || '';
  if (!path.startsWith('/') || path.startsWith('//') || (prefix && path.startsWith(prefix + '/')))
    return path;
  return prefix + path;
}
