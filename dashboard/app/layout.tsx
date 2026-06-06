import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import { Nav } from "@/components/nav";
import "./globals.css";

// IBM Plex Sans + IBM Plex Mono — the typeface pairing the E2B-inspired
// redesign asked for. next/font/google self-hosts both at build time so
// there's no extra network hop at request time and no FOUT.

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-sans-pr",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-mono-pr",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Lyncas",
  description:
    "Autonomous code review for your GitHub repositories — powered by Claude Opus.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-bg text-text bg-noise">
        {/* Nav is an async server component that branches on auth + */}
        {/* hides itself on /dashboard, /landing, /login, etc. */}
        <Nav />
        <div className="flex-1">{children}</div>
      </body>
    </html>
  );
}
