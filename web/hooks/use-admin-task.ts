'use client';
import { useRef, useState } from 'react';
import { SessionExpired } from '../lib/api';
export function useAdminTask() {
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const running = useRef(false);
  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNotice('');
    try {
      await work();
    } catch (error) {
      if (error instanceof SessionExpired) window.dispatchEvent(new Event('zero-session-expired'));
      setNotice(
        error instanceof Error
          ? error.message
          : 'No se pudo confirmar la operación. No se ha reintentado.',
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { busy, notice, setNotice, run };
}
