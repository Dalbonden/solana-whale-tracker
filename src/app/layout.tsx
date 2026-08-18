import type { Metadata, Viewport } from 'next';

import { Nav } from '@/components/nav';
import { Signature } from '@/components/signature';

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
      <head>
        {/*
          Linked rather than loaded via next/font so a blocked font host cannot
          fail the build. `latin-ext` carries the "ä"; `display=swap` means text
          paints immediately in the fallback.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Great+Vibes&subset=latin,latin-ext&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen grid-backdrop">
        <Nav />
        <main className="container pb-16 pt-6">{children}</main>
        <footer className="border-t border-border py-8">
          <div className="container flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-1.5 text-xs text-muted-foreground">
              <p className="text-sm font-medium text-foreground">
                Made by Feronyx HB
              </p>
              <p>
                &copy; {new Date().getFullYear()} Feronyx HB. All rights reserved.
                {' '}Released under the{' '}
                <a
                  href="https://github.com/Dalbonden/solana-whale-tracker/blob/main/LICENSE"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  MIT License
                </a>
                .
              </p>
              <p>
                Public on-chain data only. Read-only analytics — no trading, no custody, no
                private keys. Not financial advice.
              </p>
            </div>

            <div className="flex flex-col items-start sm:items-end">
              <Signature className="text-foreground/90" />
              <span className="mt-1 text-[10px] uppercase tracking-widest text-muted-foreground">
                Founder, Feronyx HB
              </span>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
