import type { Metadata } from 'next';
import './globals.css';
import { Toaster } from '../components/ui/sonner';
import { AdminQueryProvider } from '../components/query-provider';
export const metadata: Metadata = {
  title: 'Zero · Tu asistente, conectado',
  description: 'Configura las conexiones y permisos de Zero.',
  icons: { icon: '/icon.png' },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es" className="dark">
      <body>
        <AdminQueryProvider>{children}</AdminQueryProvider>
        <Toaster />
      </body>
    </html>
  );
}
