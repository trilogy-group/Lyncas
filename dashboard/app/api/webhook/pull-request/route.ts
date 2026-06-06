import crypto from "node:crypto";

// GitHub PR webhook → GitHub Actions workflow_dispatch.
//
// This route is intentionally thin. It does NOT review the PR inline.
// Its only job is to verify the webhook signature, filter to the two
// actionable events, and trigger the existing `pr-review.yml` workflow
// via the GitHub Actions API. The agent's LangGraph pipeline then runs
// in CI exactly the way the cron schedule already does — same code,
// same secrets, same review quality.
//
// Why dispatch instead of inline review:
//   • A single source of truth (LangGraph in `agent/`) regardless of
//     whether a PR arrived via cron or webhook. No webhook-only drift.
//   • Vercel functions have no git binary, no Python, and a 10s default
//     execution budget — running the full review inline was always
//     fighting the platform.
//   • The cron remains the safety net for missed deliveries; instant
//     dispatch is the happy path.
//
// Required env vars (set on Vercel):
//   WEBHOOK_SECRET   — same string configured in the GitHub webhook UI.
//   AGENT_WORKFLOW_PAT — fine-grained PAT with `actions: write` on the
//                        agent repo (the repo that hosts pr-review.yml).
//                        Distinct from the agent-side PR_REVIEWER_PAT
//                        (used by the Python script to read diffs / post
//                        comments on the target repos) because the two
//                        roles need access to different repos owned by
//                        potentially different GitHub accounts.
//   AGENT_REPO       — `<owner>/<repo>` of the agent repo, e.g.
//                      "trilogy-group/Lyncas". This is the
//                      repo whose Actions workflow we dispatch — NOT
//                      the repo the PR was opened against.
//   AGENT_WORKFLOW   — (optional) workflow file name. Defaults to
//                      "pr-review.yml".
//   AGENT_WORKFLOW_REF — (optional) git ref to run the workflow on.
//                      Defaults to "main".

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const REVIEWABLE_ACTIONS = new Set(["opened", "synchronize"]);

function timingSafeHexCompare(expected: string, actual: string): boolean {
  // crypto.timingSafeEqual throws on length mismatch — that itself is a
  // side channel, so check length first and only then compare.
  if (expected.length !== actual.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  } catch {
    return false;
  }
}

function verifySignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[webhook] WEBHOOK_SECRET is not set — rejecting all deliveries");
    return false;
  }
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return timingSafeHexCompare(expected, signatureHeader);
}

interface WebhookPayload {
  action?: string;
  pull_request?: { number?: number; html_url?: string };
  repository?: { full_name?: string };
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function dispatchWorkflow(meta: {
  triggerRepo: string;
  prNumber: number;
  action: string;
}): Promise<void> {
  const token = process.env.AGENT_WORKFLOW_PAT;
  const agentRepo = process.env.AGENT_REPO;
  const workflow = process.env.AGENT_WORKFLOW || "pr-review.yml";
  const ref = process.env.AGENT_WORKFLOW_REF || "main";

  if (!token) throw new Error("AGENT_WORKFLOW_PAT is not set");
  if (!agentRepo) {
    throw new Error(
      "AGENT_REPO is not set (expected '<owner>/<repo>' of the repo hosting pr-review.yml)",
    );
  }

  const url = `https://api.github.com/repos/${agentRepo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lyncas-dispatcher",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref, inputs: {} }),
  });

  // GitHub returns 204 No Content on a successful dispatch. Anything
  // else (404 — missing workflow, 422 — bad ref, 403 — PAT missing
  // `actions: write`) is a hard failure we surface to the caller.
  if (res.status !== 204) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `workflow_dispatch failed: ${res.status} ${res.statusText} — ${body.slice(0, 400)}`,
    );
  }

  console.log(
    `[webhook] dispatched ${workflow}@${ref} on ${agentRepo} for ${meta.triggerRepo}#${meta.prNumber} (action=${meta.action})`,
  );
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();

  // 1. HMAC verification — fail closed. Without the secret, anyone with
  //    the public URL could otherwise trigger workflow runs at will.
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifySignature(rawBody, signature)) {
    return jsonResponse(401, { error: "invalid signature" });
  }

  // 2. Acknowledge GitHub's `ping` test so the webhook UI shows green
  //    on the first delivery.
  const eventType = request.headers.get("x-github-event");
  if (eventType === "ping") {
    return jsonResponse(200, { pong: true });
  }
  if (eventType !== "pull_request") {
    return jsonResponse(200, { ignored: eventType ?? "unknown" });
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WebhookPayload;
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }

  // 3. Action filter — opened / synchronize only. Everything else (closed,
  //    edited, labeled, reviewed, etc.) is a no-op for us.
  const action = payload.action;
  if (!action || !REVIEWABLE_ACTIONS.has(action)) {
    return jsonResponse(200, { ignored: action ?? "no_action" });
  }

  const triggerRepo = payload.repository?.full_name;
  const prNumber = payload.pull_request?.number;
  if (!triggerRepo || typeof prNumber !== "number") {
    return jsonResponse(400, {
      error: "missing repository.full_name or pull_request.number",
    });
  }

  // 4. Dispatch and return immediately. The actual review runs in CI;
  //    its lifecycle is observed via the GitHub Actions UI and the
  //    `runs` / `reviews` tables in Supabase, same as the cron path.
  try {
    await dispatchWorkflow({ triggerRepo, prNumber, action });
    return jsonResponse(200, {
      ok: true,
      dispatched: true,
      action,
      trigger_repo: triggerRepo,
      pr_number: prNumber,
    });
  } catch (e) {
    const message = (e as Error).message;
    console.error(
      `[webhook] dispatch failed for ${triggerRepo}#${prNumber}: ${message}`,
    );
    return jsonResponse(500, {
      ok: false,
      error: message,
      trigger_repo: triggerRepo,
      pr_number: prNumber,
    });
  }
}

export async function GET(): Promise<Response> {
  return jsonResponse(405, {
    error: "POST only — this endpoint is the GitHub webhook receiver",
  });
}
