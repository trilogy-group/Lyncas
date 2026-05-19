import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { SectionHeading } from "@/components/ui/section-heading";
import { getAvailableRepos } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const repos = await getAvailableRepos();
  return (
    <Container size="narrow" className="py-10 space-y-6">
      <SectionHeading
        eyebrow="Settings"
        title="Agent configuration"
        subtitle="Read-only — values are configured in the agent and applied at runtime."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Card className="p-5">
          <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
            Model
          </div>
          <div className="mt-2 font-mono text-lg">claude-sonnet-4-5</div>
        </Card>
        <Card className="p-5">
          <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
            Diff cap
          </div>
          <div className="mt-2 font-mono text-lg">60,000 chars</div>
        </Card>
        <Card className="p-5">
          <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
            Auto-close gates
          </div>
          <ul className="mt-2 space-y-1 font-mono text-sm">
            <li>
              verdict = <span className="text-[#ff5252]">request_changes</span>
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
          <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
            Cron
          </div>
          <div className="mt-2 font-mono text-sm">scan: */15 * * * *</div>
          <div className="font-mono text-sm">digest: 0 7 * * *</div>
        </Card>
      </div>

      <Card className="p-5">
        <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
          Watched repos ({repos.length})
        </div>
        {repos.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            No repos seen yet (agent hasn&apos;t run, or no reviews exist).
          </p>
        ) : (
          <ul className="mt-3 space-y-0.5 font-mono text-sm">
            {repos.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs font-mono uppercase tracking-[0.14em] text-muted">
        Configured in{" "}
        <code className="rounded-sm border border-border px-1 py-0.5 text-[11px] normal-case tracking-normal">
          agent/pr_reviewer.py
        </code>
        . Redeploy to apply.
      </p>
    </Container>
  );
}
