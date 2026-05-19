import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { SectionHeading } from "@/components/ui/section-heading";
import { getAvailableRepos } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const repos = await getAvailableRepos();
  return (
    <Container size="narrow" className="py-10 space-y-8">
      <SectionHeading
        eyebrow="Settings"
        title="Agent configuration"
        subtitle="Read-only — values are configured in the agent and applied at runtime."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Card className="p-5" lift>
          <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
            Model
          </div>
          <div className="mt-2 font-mono text-lg font-semibold text-white">
            claude-sonnet-4-5
          </div>
        </Card>
        <Card className="p-5" lift>
          <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
            Diff cap
          </div>
          <div className="mt-2 font-mono text-lg font-semibold text-white tabular-nums">
            60,000 chars
          </div>
        </Card>
        <Card className="p-5" lift>
          <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
            Auto-close gates
          </div>
          <ul className="mt-2 space-y-1 font-mono text-sm">
            <li>
              <span className="text-muted">verdict =</span>{" "}
              <span className="text-[#ff5a5a]">request_changes</span>
            </li>
            <li>
              <span className="text-muted">confidence =</span>{" "}
              <span className="text-white">high</span>
            </li>
            <li>
              <span className="text-muted">severity ≥</span>{" "}
              <span className="text-white">9</span>
            </li>
          </ul>
        </Card>
        <Card className="p-5" lift>
          <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
            Cron
          </div>
          <div className="mt-2 font-mono text-sm text-white">
            scan: */15 * * * *
          </div>
          <div className="font-mono text-sm text-white">digest: 0 7 * * *</div>
        </Card>
      </div>

      <Card className="p-5">
        <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted">
          Watched repos ({repos.length})
        </div>
        {repos.length === 0 ? (
          <p className="mt-3 text-sm text-muted-strong">
            No repos seen yet (agent hasn&apos;t run, or no reviews exist).
          </p>
        ) : (
          <ul className="mt-3 space-y-0.5 font-mono text-sm text-white">
            {repos.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs font-mono uppercase tracking-[0.14em] text-muted">
        Configured in{" "}
        <code className="rounded-sm border border-border bg-bg-elev px-1.5 py-0.5 text-[11px] normal-case tracking-normal text-white">
          agent/pr_reviewer.py
        </code>
        . Redeploy to apply.
      </p>
    </Container>
  );
}
