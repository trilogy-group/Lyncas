import { Card } from "@/components/ui/card";
import { getAvailableRepos } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const repos = await getAvailableRepos();
  return (
    <main className="max-w-3xl mx-auto px-6 py-8 space-y-6">
      <section>
        <h1 className="text-xl font-semibold mb-1">Settings</h1>
        <p className="text-sm text-muted italic font-serif">
          read-only — configured in the agent
        </p>
      </section>

      <div className="grid sm:grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="text-[11px] font-mono uppercase tracking-wider text-muted mb-2">
            Model
          </div>
          <div className="font-mono text-lg">claude-sonnet-4-5</div>
        </Card>
        <Card className="p-5">
          <div className="text-[11px] font-mono uppercase tracking-wider text-muted mb-2">
            Diff cap
          </div>
          <div className="font-mono text-lg">60,000 chars</div>
        </Card>
        <Card className="p-5">
          <div className="text-[11px] font-mono uppercase tracking-wider text-muted mb-2">
            Auto-close gates
          </div>
          <ul className="font-mono text-sm space-y-1">
            <li>
              verdict ={" "}
              <span className="text-severity-critical">request_changes</span>
            </li>
            <li>
              confidence = <span className="text-text">high</span>
            </li>
            <li>
              severity ≥ <span className="text-text">9</span>
            </li>
          </ul>
        </Card>
        <Card className="p-5">
          <div className="text-[11px] font-mono uppercase tracking-wider text-muted mb-2">
            Cron
          </div>
          <div className="font-mono text-sm">scan: */15 * * * *</div>
          <div className="font-mono text-sm">digest: 0 7 * * *</div>
        </Card>
      </div>

      <Card className="p-5">
        <div className="text-[11px] font-mono uppercase tracking-wider text-muted mb-3">
          Watched repos ({repos.length})
        </div>
        {repos.length === 0 ? (
          <p className="text-sm text-muted">
            No repos seen yet (agent hasn&apos;t run, or no reviews exist).
          </p>
        ) : (
          <ul className="font-mono text-sm space-y-0.5">
            {repos.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs text-muted italic font-serif">
        These values are configured in the agent. Edit{" "}
        <code className="font-mono not-italic">agent/pr_reviewer.py</code> and
        redeploy to change them.
      </p>
    </main>
  );
}
