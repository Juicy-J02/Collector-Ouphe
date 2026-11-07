import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { Geist, Geist_Mono } from "next/font/google";
import {
  SESSION_COOKIE,
  getSessionUser,
} from "@/lib/server/session";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Collector Ouphe",
  description: "Track your cards, transactions, and collection value.",
};

const navigationLink =
  "nav-link rounded-lg px-3 py-2 text-sm font-medium transition-colors";

async function Timestamp() {
  "use cache";

  return <time>{new Date().getFullYear()}</time>;
}

async function AccountLink() {
  await connection();

  const cookieStore = await cookies();

  const user = await getSessionUser(
    cookieStore.get(SESSION_COOKIE)?.value
  );

  return (
    <Link
      href="/signin"
      className="account-link inline-flex max-w-48 items-center justify-center rounded-xl px-4 py-2 text-sm font-semibold transition-colors"
    >
      <span className="truncate">
        {user ? user.username : "Sign In"}
      </span>
    </Link>
  );
}

export default function RootLayout({
  children,
}: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col text-foreground">
        <a
          href="#main-content"
          className="sr-only z-50 rounded-lg bg-surface px-4 py-2 text-foreground focus:not-sr-only focus:absolute focus:left-4 focus:top-4"
        >
          Skip to content
        </a>

        <header className="site-header backdrop-blur-xl">
          <nav
            aria-label="Main navigation"
            className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-4 sm:px-6"
          >
            <Link
              href="/"
              className="group inline-flex items-center gap-3"
            >
              <span
                aria-hidden="true"
                className="brand-mark flex h-10 w-10 items-center justify-center rounded-xl text-lg font-bold"
              >
                CO
              </span>

              <span className="brand-name text-xl font-bold tracking-tight transition-colors">
                Collector Ouphe
              </span>
            </Link>

            <div className="order-3 flex w-full flex-wrap items-center gap-1 border-t border-border pt-3 sm:order-none sm:w-auto sm:border-0 sm:pt-0">
              <Link
                href="/transactions"
                className={navigationLink}
              >
                Transactions
              </Link>

              <Link
                href="/value"
                className={navigationLink}
              >
                Value Tracker
              </Link>

              <Link
                href="/collection"
                className={navigationLink}
              >
                Collections
              </Link>
            </div>

            <div className="shrink-0">
              <Suspense
                fallback={
                  <span
                    role="status"
                    className="inline-flex rounded-xl border border-border px-4 py-2 text-sm text-muted"
                  >
                    Loading…
                  </span>
                }
              >
                <AccountLink />
              </Suspense>
            </div>
          </nav>
        </header>

        <div
          id="main-content"
          tabIndex={-1}
          className="flex flex-1 flex-col"
        >
          {children}
        </div>

        <footer className="site-footer mt-12">
          <div className="mx-auto flex max-w-6xl items-center justify-center px-6 py-6 text-center text-sm text-muted">
            <p>
              © Collector Ouphe
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}