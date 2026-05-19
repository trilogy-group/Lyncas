import { type NextRequest } from "next/server";
import {
  createSupabaseServerClient,
  getUser,
} from "@/lib/supabase/server";
import { resolveGithubToken } from "@/lib/github-token";
import type {
  SandboxOverall,
  SandboxProgressEvent,
  SandboxStep,
} from "@/lib/types";

// POST /api/devpod/run-pr-tests
//
// Drives the same five-step sandbox sequence as agent/devpod_tester.py,
// but on demand from the dashboard chat UI's "🧪 Run sandbox test"
// button. Streams progress as Server-Sent Events so the user sees
// per-step "running" → "done" transitions instead of a single
// long-pending request.
//
// Auth: Supabase JWT. Looks up the caller's own active DevPod session
// + GitHub installation token for the repo, then fans out 5
// sequential MCP /execute calls.
//
// On completion, upserts pr_sandbox_results so the chat report
// (isReport=true) and the chat sidebar can read the result back
// later without rerunning the suite.
//
// We deliberately do NOT call /api/devpod/execute internally — that
// endpoint is JWT-auth, route-level, and would round-trip the
// command through HTTP twice. Calling the user's tunnel directly
// keeps the latency floor low and means an upstream tunnel error is
// visible in this route's own try/catch.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MCP_TIMEOUT_MS = 180_000; // matches devpod_tester.py STEP_TIMEOUT
const MAX_OUTPUT_BYTES = 16 * 1024;
const APP_PORT = 3001;

interface MCPResponse {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  success?: boolean;
  error?: string;
  url?: string | null;
  started?: boolean;
  pid?: number;
  port?: number;
  test_runner?: string;
}

interface RequestBody {
  repo?: unknown;
  pr_number?: unknown;
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function truncate(text: string, limit = MAX_OUTPUT_BYTES): string {
  if (!text) return "";
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\n…[truncated]";
}

// Same heuristic used in agent/devpod_tester.py — keep both in sync
// or the dashboard and the webhook-driven runs disagree on counts.
function countPassedFailed(blob: string): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  const mp = /(\d+)\s+passed/.exec(blob);
  if (mp) passed = Number(mp[1]);
  const mf = /(\d+)\s+failed/.exec(blob);
  if (mf) failed = Number(mf[1]);
  if (passed === 0 && failed === 0) {
    const mp2 = /(\d+)\s+passing/.exec(blob);
    if (mp2) passed = Number(mp2[1]);
    const mf2 = /(\d+)\s+failing/.exec(blob);
    if (mf2) failed = Number(mf2[1]);
  }
  return { passed, failed };
}

function looksLikeNoTests(blob: string): boolean {
  const b = blob.toLowerCase();
  return (
    b.includes("no test runner detected") ||
    b.includes("no tests found") ||
    b.includes("no tests collected") ||
    b.includes("no tests ran") ||
    b.includes("found 0 test")
  );
}

async function postExecute(
  tunnelUrl: string,
  body: Record<string, unknown>,
): Promise<MCPResponse> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), MCP_TIMEOUT_MS);
  try {
    const res = await fetch(tunnelUrl.replace(/\/$/, "") + "/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
      cache: "no-store",
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as MCPResponse;
    } catch {
      return {
        error: `non-JSON MCP response (HTTP ${res.status})`,
        stderr: text.slice(0, 1000),
        exit_code: -1,
      };
    }
  } catch (e) {
    return {
      error:
        (e as Error).name === "AbortError"
          ? `step timed out after ${MCP_TIMEOUT_MS / 1000}s`
          : (e as Error).message,
      exit_code: -1,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Compose the same one-line shell expression used by
// agent/devpod_tester.py._checkout_command. Centralizing the literal
// would mean a shared file, which the build doesn't import — keep
// this in sync with the Python helper if the workspace-copy
// fast-path ever changes.
function checkoutCommand(
  repo: string,
  prNumber: number,
  ghToken: string | null,
): string {
  const targetDir = `"$HOME/pr-test-${prNumber}"`;
  const cloneUrl = ghToken
    ? `https://x-access-token:${ghToken}@github.com/${repo}.git`
    : `https://github.com/${repo}.git`;
  return [
    `rm -rf ${targetDir}`,
    `WORKSPACE="\${DEVPOD_WORKSPACE_FOLDER:-}"`,
    `( [ -n "$WORKSPACE" ] && [ -d "$WORKSPACE/.git" ] && ` +
      `cp -r "$WORKSPACE" ${targetDir} ` +
      `|| git clone --depth=1 "${cloneUrl}" ${targetDir} )`,
    `cd ${targetDir}`,
    `(git branch -D pr-branch 2>/dev/null || true)`,
    `git fetch origin pull/${prNumber}/head:pr-branch`,
    `git checkout pr-branch`,
  ].join(" && ");
}

function installCommand(prNumber: number): string {
  const work = `"$HOME/pr-test-${prNumber}"`;
  return (
    `cd ${work} && ` +
    `( [ -f package.json ] && npm install --no-audit --no-fund 2>&1 || ` +
    `[ -f requirements.txt ] && pip install -r requirements.txt 2>&1 || ` +
    `echo "no deps detected" )`
  );
}

function startAppCommand(prNumber: number, port: number): string {
  const work = `"$HOME/pr-test-${prNumber}"`;
  return (
    `cd ${work} && ` +
    `export PORT=${port} && ` +
    `( npm start 2>/dev/null ` +
    `|| python app.py 2>/dev/null ` +
    `|| python main.py 2>/dev/null ` +
    `|| echo "no entrypoint detected" )`
  );
}

export async function POST(request: NextRequest) {
  const user = await getUser().catch(() => null);
  if (!user) return jsonError("Not authenticated", 401);

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return jsonError("Body must be JSON", 400);
  }
  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  const prNumberRaw =
    typeof body.pr_number === "number"
      ? body.pr_number
      : Number(body.pr_number);
  if (!repo || !Number.isFinite(prNumberRaw) || prNumberRaw <= 0) {
    return jsonError("`repo` + `pr_number` are required", 400);
  }
  const prNumber = Math.trunc(prNumberRaw);

  const supabase = await createSupabaseServerClient();

  // Active session lookup. Same liveness rule as /api/devpod/status:
  // status='active' AND expires_at in the future. We don't trust
  // the caller's claim that DevPod is live — they may be racing a
  // /disconnect.
  const { data: session } = await supabase
    .from("devpod_sessions")
    .select("id, tunnel_url, status, expires_at")
    .eq("user_id", user.id)
    .order("connected_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const live =
    !!session &&
    session.status === "active" &&
    Date.parse(session.expires_at) > Date.now();
  if (!session || !live) {
    return jsonError("No active DevPod session", 404);
  }

  // GitHub token for the (private-repo) clone fallback.
  const resolved = await resolveGithubToken({
    supabase,
    userId: user.id,
    repo,
    fallbackPat: process.env.PR_REVIEWER_PAT,
  });
  // No-token is fine for public repos; the clone URL falls back to
  // an anonymous https://github.com/... clone. Private repos will
  // 404 inside the DevPod, which we surface as clone failure.

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function emit(evt: SandboxProgressEvent) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
      }
      function emitStep(
        step: SandboxStep,
        status: "running" | "done" | "error",
        extra: Partial<SandboxProgressEvent> = {},
      ) {
        emit({ step, status, ...extra });
      }

      try {
        // ----- Step 1: clone / copy + checkout -----
        emitStep("clone", "running");
        const checkout = await postExecute(session.tunnel_url, {
          type: "run_command",
          repo,
          command: checkoutCommand(repo, prNumber, resolved.token),
        });
        const cloneSuccess =
          checkout.success === true || checkout.exit_code === 0;
        emitStep("clone", cloneSuccess ? "done" : "error", {
          success: cloneSuccess,
          ...(cloneSuccess ? {} : { error: checkout.error ?? checkout.stderr }),
        });

        // ----- Step 2: install (best-effort; never blocks tests) -----
        let installSuccess = false;
        if (cloneSuccess) {
          emitStep("install", "running");
          const install = await postExecute(session.tunnel_url, {
            type: "run_command",
            repo,
            command: installCommand(prNumber),
          });
          installSuccess =
            install.success === true || install.exit_code === 0;
          emitStep("install", "done", { success: installSuccess });
        }

        // ----- Step 3: run tests -----
        let testsPassed = 0;
        let testsFailed = 0;
        let testOutput = "";
        if (cloneSuccess) {
          emitStep("tests", "running");
          const testResp = await postExecute(session.tunnel_url, {
            type: "run_tests",
            repo,
            cwd: `~/pr-test-${prNumber}`,
          });
          const blob =
            (testResp.stdout ?? "") +
            (testResp.stderr ? "\n" + testResp.stderr : "");
          ({ passed: testsPassed, failed: testsFailed } =
            countPassedFailed(blob));
          testOutput = blob;
          emitStep("tests", "done", {
            passed: testsPassed,
            failed: testsFailed,
            success: testsFailed === 0 && testsPassed > 0,
          });
        }

        // ----- Step 4: start app (only if tests cleanly passed) -----
        let appStarted = false;
        if (cloneSuccess && testsFailed === 0 && testsPassed > 0) {
          emitStep("app", "running");
          const start = await postExecute(session.tunnel_url, {
            type: "start_app",
            repo,
            command: startAppCommand(prNumber, APP_PORT),
            cwd: `~/pr-test-${prNumber}`,
          });
          appStarted = start.started === true;
          emitStep("app", "done", { success: appStarted });
        }

        // ----- Step 5: expose port -----
        let appUrl: string | null = null;
        if (appStarted) {
          emitStep("expose", "running");
          const expose = await postExecute(session.tunnel_url, {
            type: "expose_port",
            repo,
            port: APP_PORT,
          });
          appUrl = typeof expose.url === "string" ? expose.url : null;
          emitStep("expose", "done", { url: appUrl, success: !!appUrl });
        }

        // Aggregate
        let overall: SandboxOverall;
        if (!cloneSuccess) overall = "error";
        else if (looksLikeNoTests(testOutput)) overall = "no_tests";
        else if (testsFailed > 0) overall = "fail";
        else if (testsPassed > 0) overall = "pass";
        else overall = "no_tests";

        const duration_ms = Date.now() - startedAt;

        // Persist. Best-effort — a DB error here must not eat the
        // SSE "complete" event the UI is waiting for.
        try {
          await supabase
            .from("pr_sandbox_results")
            .upsert(
              {
                repo,
                pr_number: prNumber,
                user_id: user.id,
                session_id: session.id,
                tests_passed: testsPassed,
                tests_failed: testsFailed,
                test_output: truncate(testOutput),
                app_url: appUrl,
                app_started: appStarted,
                clone_success: cloneSuccess,
                install_success: installSuccess,
                overall,
                duration_ms,
              },
              { onConflict: "repo,pr_number" },
            );
        } catch (e) {
          console.warn(
            `[run-pr-tests] persist failed: ${(e as Error).message}`,
          );
        }

        emitStep("complete", "done", {
          overall,
          duration_ms,
          url: appUrl,
        });
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
        controller.close();
      } catch (e) {
        emitStep("complete", "error", { error: (e as Error).message });
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
