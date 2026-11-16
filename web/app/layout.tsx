import type { Metadata } from 'next';
import './globals.css';
import { I18nProvider } from '../i18n/provider';
import { Toaster } from '../components/ui/sonner';
import { AdminQueryProvider } from '../components/query-provider';
export const metadata: Metadata = {
  title: 'ZeroSE · Your connected assistant',
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
            visibility: visible; min-height: 100svh; display: grid; place-items: center;
            font: 15px ui-sans-serif, system-ui, sans-serif; color: #94a3b8;
            animation: page-loading-in 200ms ease-out 150ms both;
          }
          .page-loading-mark { display: grid; justify-items: center; gap: 14px; padding: 16px; }
          .page-loading-mark img { width: 56px; height: 56px; border-radius: 16px; }
          .page-loading-word {
            color: #f8fafc; font-size: 28px; font-weight: 700; letter-spacing: -1.5px; line-height: 1;
          }
          .page-loading-word span { color: #f97316; }
          .page-loading-bar {
            position: relative; width: 120px; height: 3px; margin-top: 6px;
            overflow: hidden; border-radius: 3px; background: #1e293b;
          }
          .page-loading-bar span {
            position: absolute; inset: 0 auto 0 0; width: 40%; border-radius: inherit;
            background: #f97316; animation: page-loading-bar 1.1s ease-in-out infinite;
          }
          .page-loading-label { font-size: 13px; }
          @keyframes page-loading-bar { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
          @keyframes page-loading-in { from { opacity: 0; } to { opacity: 1; } }
          @media (prefers-reduced-motion: reduce) {
            .page-loading { animation: none; }
            .page-loading-bar span { animation: none; width: 100%; opacity: 0.6; }
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
