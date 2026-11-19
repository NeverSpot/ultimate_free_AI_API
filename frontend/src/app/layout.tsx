import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import Link from 'next/link';
import React from 'react';
import { AuthNav } from '@/components/auth-nav';
import { SessionProvider } from '@/components/session-provider';
import { Footer } from '@/components/site/footer';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

const DESCRIPTION =
  'Pool your free-tier provider keys behind one OpenAI-compatible endpoint with capacity-aware routing and failover.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Ultimate Free AI Endpoint',
    template: '%s · Ultimate Free AI Endpoint',
  },
  description: DESCRIPTION,
  applicationName: 'Ultimate Free AI Endpoint',
  openGraph: {
    type: 'website',
    url: '/',
    siteName: 'Ultimate Free AI Endpoint',
    title: 'Ultimate Free AI Endpoint',
    description: DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Ultimate Free AI Endpoint',
    description: DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-slate-950 text-slate-100">
        <SessionProvider>
          <header className="border-b border-slate-800/60 bg-slate-950">
            <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
              <Link
                href="/"
                className="inline-flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-100 transition hover:text-copper-lift"
              >
                <span className="h-2 w-2 rounded-sm bg-copper" aria-hidden />
                Ultimate Free AI Endpoint
              </Link>
              <AuthNav />
            </div>
          </header>
          <main className="flex-1">{children}</main>
          <Footer />
        </SessionProvider>
      </body>
    </html>
  );
}
