// FRACTAL: implements F1, F5, F14 | component C10
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { ensureSessionToken } from '@/api/token';
import { AppCliBanner } from '@/ui/components/AppCliBanner';
// WHY: imported before globals.css so the app's own type scale wins where the two meet.
// KaTeX ships its fonts alongside this file; the bundler rewrites their URLs, so nothing
// is fetched from a CDN and the app stays fully self-hosted and offline-capable.
import 'katex/dist/katex.min.css';
import './globals.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Learning tracker',
  description: 'Your subjects, lessons and reviews, kept on this computer.',
};

/**
 * WHY (H12): the per-launch credential is placed in the document this app itself serves,
 * so only a page loaded from this app carries it. It is never logged and never stored.
 */
export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  const token = ensureSessionToken();
  return (
    <html lang="en" data-theme="dark">
      <body>
        <meta name="la-token" content={token} />
        {/* WHY: every surface the app has must be reachable by clicking from any page —
            a page only a typed URL can open is a page nobody finds. */}
        <nav className="la-nav">
          <Link href="/" data-testid="nav-home">Home</Link>
          <Link href="/review" data-testid="nav-review">Worth revisiting</Link>
          <Link href="/practice" data-testid="nav-practice">Mixed practice</Link>
          <Link href="/cards" data-testid="nav-cards">Flash cards</Link>
          <Link href="/synthesis" data-testid="nav-synthesis">Link two subjects</Link>
          <Link href="/journal" data-testid="nav-journal">Your notes</Link>
          <Link href="/settings" data-testid="nav-settings">Settings</Link>
        </nav>
        {/* WHY (H2): whether the AI helper is installed is a property of the app, not of any
            one page. Rendered here, no route can be added without it and no navigation can
            drop it — a class of bug the delivery walkthrough found on four pages. */}
        <main className="la-main">
          <AppCliBanner />
          {children}
        </main>
      </body>
    </html>
  );
}
