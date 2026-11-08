import type { Metadata } from 'next';
import './globals.css';
import { I18nProvider } from '../i18n/provider';
import { Toaster } from '../components/ui/sonner';
import { AdminQueryProvider } from '../components/query-provider';
export const metadata: Metadata = {
  title: 'Zero · Your connected assistant',
  description: 'Configure Zero connections and permissions.',
  icons: { icon: '/icon.png' },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <head>
        <style>{`
          html { background: #030b1c; color-scheme: dark; }
          body { margin: 0; visibility: hidden; }
          [data-ui-shell] { visibility: hidden; }
          .page-loading {
            visibility: visible; min-height: 100svh;
          }
          .page-loading [data-slot="skeleton"] {
            background: #1e293b; border-radius: 0.375rem;
          }
        `}</style>
      </head>
      <body>
        <I18nProvider>
          <AdminQueryProvider>{children}</AdminQueryProvider>
          <Toaster />
        </I18nProvider>
      </body>
    </html>
  );
}
