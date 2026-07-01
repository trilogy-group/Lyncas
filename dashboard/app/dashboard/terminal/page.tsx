import { redirect } from "next/navigation";
import { Container } from "@/components/ui/container";
import { GridBackdrop } from "@/components/ui/grid-backdrop";
import { SectionHeading } from "@/components/ui/section-heading";
import { WebTerminal } from "@/components/web-terminal";
import { getUser } from "@/lib/supabase/server";

// /dashboard/terminal
//
// A live, interactive shell on the Lyncas "house terminal" — a
// Lyncas-controlled Linux box (currently the same EC2 instance that
// runs the webhook handler) reachable over a Cloudflare-tunnelled
// WebSocket. Lets a user who hasn't connected their own DevPod work on
// a real machine straight from the dashboard.
//
// First slice of Improvements.md item 4. NO per-user isolation yet:
// everyone shares one box. The banner below says so on purpose.

export const dynamic = "force-dynamic";

export default async function DashboardTerminalPage() {
  const user = await getUser().catch(() => null);
  if (!user) redirect("/login");

  return (
    <div className="relative">
      <GridBackdrop tone="amber" />
      <Container className="relative space-y-6 py-10">
        <SectionHeading
          eyebrow="Terminal"
          title="LIVE TERMINAL"
          subtitle="A real interactive shell on the Lyncas runner. Type commands, run builds, inspect a PR checkout — straight from the browser, no DevPod required."
        />

        <div className="rounded-md border border-[#ffbd2e]/30 bg-[#ffbd2e]/10 px-4 py-3">
          <p className="text-[12px] leading-relaxed text-[#f6c25b]">
            <span className="font-semibold">Testing environment.</span> This
            connects to the shared EC2 box with no per-user isolation yet —
            every session lands on the same machine. Don&apos;t run anything
            sensitive or destructive here.
          </p>
        </div>

        <WebTerminal />
      </Container>
    </div>
  );
}
