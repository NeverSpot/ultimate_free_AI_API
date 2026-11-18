import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import Link from 'next/link';
import React from 'react';
import { AuthNav } from '@/components/auth-nav';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Ultimate Free AI Endpoint',
  description:
    'One API endpoint, many provider keys. Free-tier LLM access with capacity-first routing.',
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
        <header className="border-t-2 border-t-copper border-b border-slate-800 bg-slate-900/60 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
            <Link href="/" className="inline-flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-100 transition hover:text-copper-lift">
              <span className="h-2 w-2 rounded-sm bg-copper" aria-hidden />
              Ultimate Free AI Endpoint
            </Link>
            <AuthNav />
          </div>
        </header>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
