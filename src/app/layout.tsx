import type { Metadata, Viewport } from 'next';

import { Nav } from '@/components/nav';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Solana Whale Tracker',
    template: '%s · Whale Tracker',
  },
  description:
    'Read-only analytics tracking Solana whale wallets across meme tokens — trades, portfolios, rotations and real-time alerts.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#09090b',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen grid-backdrop">
        <Nav />
        <main className="container pb-16 pt-6">{children}</main>
        <footer className="border-t border-border py-6">
          <div className="container flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <p>
              Public on-chain data only. Read-only analytics — no trading, no custody, no private keys.
            </p>
            <p>Not financial advice.</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
