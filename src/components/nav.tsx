'use client';

import { Activity, Bell, Coins, LayoutDashboard, Search, Waves } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/whales', label: 'Whales', icon: Waves },
  { href: '/tokens', label: 'Tokens', icon: Coins },
  { href: '/activity', label: 'Activity', icon: Activity },
  { href: '/alerts', label: 'Alerts', icon: Bell },
  { href: '/forensics', label: 'Forensics', icon: Search },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="container flex h-14 items-center gap-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-primary/15 text-primary">
            <Waves className="h-4 w-4" />
          </span>
          <span className="hidden sm:inline">Whale Tracker</span>
        </Link>

        <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
          {LINKS.map((link) => {
            const active =
              link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
            const Icon = link.icon;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden md:inline">{link.label}</span>
              </Link>
            );
          })}
        </nav>

        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground lg:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--bull))] animate-pulse-ring" />
          Solana mainnet
        </span>
      </div>
    </header>
  );
}
