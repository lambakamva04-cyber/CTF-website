import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import Script from 'next/script';

import './globals.css';

// Self-hosted at build time by next/font, so the first paint needs no round
// trip to Google. These links are opened on phones, on mobile data, between
// patients — every avoidable request is one too many.
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-space-grotesk',
  display: 'swap',
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Hope — Cut Through Faster',
  // A prospect's name must never turn up in a search result.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#f7f6f3',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-ZA" className={`${inter.variable} ${spaceGrotesk.variable} ${jetBrainsMono.variable}`}>
      <body>
        {children}
        {/* The accessibility menu (text size, high contrast, what is built in).
            A plain script in public/, shared with the marketing site and the
            dashboard. */}
        <Script src="/a11y.js" data-site="demo" strategy="afterInteractive" />
      </body>
    </html>
  );
}
