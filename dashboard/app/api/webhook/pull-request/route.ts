import crypto from "node:crypto";

import { reviewPullRequest, type WebhookPullRequest } from "@/lib/webhook/review";

// Phase 5: GitHub PR webhook → inline review.
//
// Triggered by GitHub on `pull_request` events. Verifies the HMAC-SHA256
// signature using WEBHOOK_SECRET, ignores anything other than `opened` /
// `synchronize` / `reopened`, then runs the same review pipeline as the
// 10-minute cron (agent/pr_reviewer.py).
//
// The cron stays running as a fallback — if a webhook delivery is dropped
// (transient Vercel outage, GitHub queue blip) the cron will catch it on
// its next tick.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const REVIEWABLE_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

function timingSafeHexCompare(expected: string, actual: string): boolean {
  // crypto.timingSafeEqual throws on length mismatch, which would itself be
  // a side channel — guard the length first.
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
  pull_request?: WebhookPullRequest;
  repository?: { full_name?: string };
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();

  // 1. HMAC verification — strict. A misconfigured secret should fail
  //    closed, not open: anyone with the public URL could otherwise post
  //    arbitrary "PRs" and burn ANTHROPIC_API_KEY budget.
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifySignature(rawBody, signature)) {
    return jsonResponse(401, { error: "invalid signature" });
  }

  // 2. Acknowledge ping events explicitly so the GitHub webhook UI shows
  //    a 200 OK when the user clicks "Redeliver" on the test ping.
  const eventType = request.headers.get("x-github-event");
  if (eventType === "ping") {
    return jsonResponse(200, { pong: true });
  }
  if (eventType !== "pull_request") {
    return jsonResponse(200, { ignored: eventType ?? "unknown" });
  }

  // 3. Parse — never let a malformed body crash the function.
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WebhookPayload;
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }

  const action = payload.action;
  if (!action || !REVIEWABLE_ACTIONS.has(action)) {
    return jsonResponse(200, { ignored: action ?? "no_action" });
  }

  const repo = payload.repository?.full_name;
  const pr = payload.pull_request;
  if (!repo || !pr || typeof pr.number !== "number") {
    return jsonResponse(400, { error: "missing repository.full_name or pull_request fields" });
  }

  // 4. Run the review pipeline. Every internal call has its own try/catch;
  //    this outer wrapper exists so an unexpected throw still returns JSON
  //    instead of an HTML stack trace.
  try {
    console.log(`[webhook] received ${action} for ${repo}#${pr.number} (${pr.html_url})`);
    const result = await reviewPullRequest(repo, pr);
    return jsonResponse(200, {
      ok: true,
      action,
      repo,
      pr_number: pr.number,
      result,
    });
  } catch (e) {
    const message = (e as Error).message;
    console.error(`[webhook] ${repo}#${pr.number} failed:`, message);
    return jsonResponse(500, {
      ok: false,
      error: message,
      repo,
      pr_number: pr.number,
    });
  }
}

export async function GET(): Promise<Response> {
  return jsonResponse(405, { error: "POST only — this endpoint is the GitHub webhook receiver" });
}
