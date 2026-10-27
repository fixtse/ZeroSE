'use client';
import { useRef, useState } from 'react';
import { notify as setNotice, notifyError } from '../lib/notifications';
import { SessionExpired } from '../lib/api';
export function useAdminTask() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      if (error instanceof SessionExpired) window.dispatchEvent(new Event('zero-session-expired'));
      notifyError(
        error instanceof Error
          ? error.message
          : 'No se pudo confirmar la operación. No se ha reintentado.',
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { busy, setNotice, run };
}
