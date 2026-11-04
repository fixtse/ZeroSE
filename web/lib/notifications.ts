'use client';
import { translateNotice } from '../i18n/notice';
import { toast } from 'sonner';

export function notify(message: string) {
  if (message) toast.success(translateNotice(message));
}
export function notifyError(
  error: unknown,
  fallback = 'No se pudo confirmar la operación. No se ha reintentado.',
) {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;
  toast.error(translateNotice(message), { duration: 8000 });
}
export function notifyWarning(message: string) {
  if (message) toast.warning(translateNotice(message), { duration: 8000 });
}
