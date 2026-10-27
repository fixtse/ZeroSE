'use client';
import { toast } from 'sonner';

export function notify(message: string) {
  if (message) toast.success(message);
}
export function notifyError(
  error: unknown,
  fallback = 'No se pudo confirmar la operación. No se ha reintentado.',
) {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;
  toast.error(message, { duration: 8000 });
}
export function notifyWarning(message: string) {
  if (message) toast.warning(message, { duration: 8000 });
}
