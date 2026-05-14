import Link from "next/link";

export function Nav() {
  return (
    <nav className="border-b border-border bg-card">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link
          href="/"
          className="font-semibold text-sm tracking-tight hover:text-accent transition-colors"
        >
          Night PR Reviewer
        </Link>
        <div className="flex items-center gap-6 text-sm font-mono">
          <Link
            href="/"
            className="text-muted hover:text-text transition-colors"
          >
            overview
          </Link>
          <Link
            href="/repos"
            className="text-muted hover:text-text transition-colors"
          >
            repos
          </Link>
          <Link
            href="/runs"
            className="text-muted hover:text-text transition-colors"
          >
            runs
          </Link>
          <Link
            href="/benchmark"
            className="text-muted hover:text-text transition-colors"
          >
            benchmark
          </Link>
          <Link
            href="/settings"
            className="text-muted hover:text-text transition-colors"
          >
            settings
          </Link>
        </div>
      </div>
    </nav>
  );
}
