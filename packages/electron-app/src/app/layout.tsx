import type { Metadata, Viewport } from 'next';
import './globals.css';
import GlobalLoader from '@/components/GlobalLoader';

export const metadata: Metadata = {
  title: 'AI 사업부 허브',
  description: 'AI Company Dashboard',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body>
        {children}
        <GlobalLoader />
      </body>
    </html>
  );
}
