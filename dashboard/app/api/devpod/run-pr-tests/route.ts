import { type NextRequest } from "next/server";
import {
  createSupabaseServerClient,
  getUser,
} from "@/lib/supabase/server";
import { resolveGithubToken } from "@/lib/github-token";
import {
  verdictToDbOverall,
  type SandboxProgressEvent,
  type SandboxStep,
  type SandboxVerdict,
} from "@/lib/types";

// POST /api/devpod/run-pr-tests
//
// Drives the same sandbox sequence as agent/devpod_tester.py, but on
// demand from the dashboard chat UI's "🧪 Run sandbox test" button.
// Streams progress as Server-Sent Events so the user sees per-step
// "running" → "done" transitions instead of a single long-pending
// request.
//
// Step order, mirroring the Python flow:
//   1. clone     — copy/clone the PR branch
//   2. install   — best-effort dependency install
//   3. tests     — auto-detected test runner
//   4. build     — `npm run build` / `go build` / no-op for Python
//   5. app       — start_app + multi-port probe + expose_port (the
//                  pre-v2 "expose" step is folded into this one
//                  because emitting two events for one user-visible
//                  thing was just noise).
//   6. complete  — terminal event with the rich verdict + duration_ms
//
// Auth: Supabase JWT. Looks up the caller's own active DevPod session
// + GitHub installation token for the repo, then fans out sequential
// MCP /execute calls.
//
// On completion, upserts pr_sandbox_results so the chat report
// (isReport=true) and the chat sidebar can read the result back
// later without rerunning the suite. The DB column is bounded to
// the legacy 4-value enum by migration 015's CHECK, so the rich
// verdict gets mapped down via verdictToDbOverall() before insert —
// the SSE stream + the UI keep the richer information.
//
// We deliberately do NOT call /api/devpod/execute internally — that
// endpoint is JWT-auth, route-level, and would round-trip the
// command through HTTP twice. Calling the user's tunnel directly
// keeps the latency floor low and means an upstream tunnel error is
// visible in this route's own try/catch.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Tunnel-side per-step timeout cap (the slowest MCP server-side
// cap is 300s on run_tests; we wait a hair longer so a server-side
// timeout reaches us as a clean error rather than as an aborted
// fetch). The build step is bounded server-side at 180s.
const MCP_TIMEOUT_MS = 360_000;
const MAX_OUTPUT_BYTES = 16 * 1024;
const APP_BIND_TIMEOUT_SEC = 8;

// Mirrors APP_PORT_CANDIDATES in agent/devpod_tester.py — see the
// comment there for why we probe rather than force a single port.
const APP_PORT_CANDIDATES = [3000, 8000, 8080, 5000] as const;

// Where we clone the PR into on the DevPod. Mirrors
// SANDBOX_CLONE_DIR in agent/devpod_tester.py — both paths must
// agree on the destination or the webhook-driven run and the
// chat-button-driven run will drift (the agent persists with
// /tmp/pr-test as cwd while the dashboard re-runs would persist
// with $HOME/pr-test-N as cwd, and a follow-up re-test would not
// find the prior tree).
const SANDBOX_CLONE_DIR = "/tmp/pr-test";

// Sentinel printed at the tail of the clone command. The dashboard
// route applies the same stricter rule as the Python script: an
// exit-zero from git is not by itself proof of a clean checkout
// (codespaces-base has been seen leaving partial trees on a
// mid-fetch network blip). The marker on stdout is the only thing
// that promotes the clone to clone_success=true.
const CLONE_SUCCESS_MARKER = "CLONE_SUCCESS";

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
  build_runner?: string;
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
// this in sync with the Python helper. v2 dropped the workspace-copy
// fast-path; both runners now use a deterministic clone into
// SANDBOX_CLONE_DIR and require the CLONE_SUCCESS marker on
// stdout to promote the run to clone_success=true.
function checkoutCommand(
  repo: string,
  prNumber: number,
  ghToken: string | null,
): string {
  const cloneUrl = ghToken
    ? `https://x-access-token:${ghToken}@github.com/${repo}.git`
    : `https://github.com/${repo}.git`;
  return [
    `rm -rf ${SANDBOX_CLONE_DIR}`,
    `git clone --depth=1 "${cloneUrl}" ${SANDBOX_CLONE_DIR}`,
    `cd ${SANDBOX_CLONE_DIR}`,
    `git fetch origin pull/${prNumber}/head:pr-branch`,
    `git checkout pr-branch`,
    `echo ${CLONE_SUCCESS_MARKER}`,
  ].join(" && ");
}

function installCommand(): string {
  return (
    `cd ${SANDBOX_CLONE_DIR} && ` +
    `( [ -f package.json ] && npm install --no-audit --no-fund 2>&1 || ` +
    `[ -f requirements.txt ] && pip install -r requirements.txt 2>&1 || ` +
    `[ -f go.mod ] && go mod download 2>&1 || ` +
    `echo "no deps detected" )`
  );
}

function startAppCommand(): string {
  return (
    `cd ${SANDBOX_CLONE_DIR} && ` +
    `export PORT=3000 && ` +
    `( npm start 2>&1 ` +
    `|| python app.py 2>&1 ` +
    `|| python main.py 2>&1 ` +
    `|| go run . 2>&1 ` +
    `|| echo "no entrypoint detected" )`
  );
}

// Returns a shell expression that polls each candidate port once
// per second for up to APP_BIND_TIMEOUT_SEC seconds and prints the
// first responding port to stdout. Mirrors the Python equivalent
// in devpod_tester.py — see comment there for the rationale.
function portDetectCommand(): string {
  const ports = APP_PORT_CANDIDATES.join(" ");
  return (
    `for i in $(seq 1 ${APP_BIND_TIMEOUT_SEC}); do ` +
    `  for p in ${ports}; do ` +
    `    if curl -sI --max-time 1 "http://localhost:$p" ` +
    `      >/dev/null 2>&1; then ` +
    `      echo $p; exit 0; ` +
    `    fi; ` +
    `  done; ` +
    `  sleep 1; ` +
    `done; ` +
    `exit 1`
  );
}

function computeVerdict(args: {
  cloneSuccess: boolean;
  installSuccess: boolean;
  testsPassed: number;
  testsFailed: number;
  noTests: boolean;
  buildAttempted: boolean;
  buildSuccess: boolean;
  appStarted: boolean;
  appUrl: string | null;
}): SandboxVerdict {
  if (!args.cloneSuccess || !args.installSuccess) return "error";
  if (args.buildAttempted && !args.buildSuccess) return "build_failed";
  if (args.testsFailed > 0) return "tests_failed";
  if (args.noTests) return "no_tests";
  if (args.appStarted && args.appUrl) return "pass";
  return "pass_no_preview";
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
        // Marker check mirrors agent/devpod_tester.py: an exit-zero
        // from git alone is not sufficient — codespaces-base has
        // been observed leaving partial trees on mid-fetch network
        // blips. Stdout must contain CLONE_SUCCESS for the clone to
        // promote to success.
        emitStep("clone", "running");
        const checkout = await postExecute(session.tunnel_url, {
          type: "run_command",
          repo,
          command: checkoutCommand(repo, prNumber, resolved.token),
        });
        const cloneExitZero =
          checkout.success === true || checkout.exit_code === 0;
        const cloneMarkerSeen = (checkout.stdout ?? "").includes(
          CLONE_SUCCESS_MARKER,
        );
        const cloneSuccess = cloneExitZero && cloneMarkerSeen;
        const cloneError = cloneSuccess
          ? undefined
          : !cloneMarkerSeen && cloneExitZero
            ? "clone command exited 0 but CLONE_SUCCESS marker missing — likely a partial checkout"
            : (checkout.error ?? checkout.stderr);
        emitStep("clone", cloneSuccess ? "done" : "error", {
          success: cloneSuccess,
          ...(cloneSuccess ? {} : { error: cloneError }),
        });

        // ----- Step 2: install -----
        // Gated on cloneSuccess — same contract the agent enforces.
        // A failed clone means downstream steps cannot produce
        // meaningful signal, so we short-circuit straight to the
        // verdict computation below.
        let installSuccess = false;
        if (cloneSuccess) {
          emitStep("install", "running");
          const install = await postExecute(session.tunnel_url, {
            type: "run_command",
            repo,
            command: installCommand(),
          });
          installSuccess =
            install.success === true || install.exit_code === 0;
          emitStep("install", installSuccess ? "done" : "error", {
            success: installSuccess,
            ...(installSuccess ? {} : { error: install.stderr ?? install.error }),
          });
        }

        // ----- Step 3: run tests -----
        let testsPassed = 0;
        let testsFailed = 0;
        let testOutput = "";
        let noTests = false;
        if (cloneSuccess && installSuccess) {
          emitStep("tests", "running");
          const testResp = await postExecute(session.tunnel_url, {
            type: "run_tests",
            repo,
            cwd: SANDBOX_CLONE_DIR,
          });
          const blob =
            (testResp.stdout ?? "") +
            (testResp.stderr ? "\n" + testResp.stderr : "");
          ({ passed: testsPassed, failed: testsFailed } =
            countPassedFailed(blob));
          testOutput = blob;
          noTests =
            looksLikeNoTests(blob) ||
            (testsPassed === 0 && testsFailed === 0);
          emitStep("tests", "done", {
            passed: testsPassed,
            failed: testsFailed,
            success: testsFailed === 0 && testsPassed > 0,
          });
        }

        // ----- Step 4: build -----
        // Attempted whenever clone + install both passed; the
        // MCP server's build handler auto-detects npm / go / py
        // and times out at 180s. An older MCP server returns
        // {"error":"unknown type: build"} and we soft-skip that
        // case so unupgraded DevPods don't get red-flagged.
        let buildAttempted = false;
        let buildSuccess = false;
        let buildOutput = "";
        if (cloneSuccess && installSuccess) {
          emitStep("build", "running");
          const buildResp = await postExecute(session.tunnel_url, {
            type: "build",
            repo,
            cwd: SANDBOX_CLONE_DIR,
          });
          const errStr = (buildResp.error ?? "").toLowerCase();
          if (errStr.includes("unknown type")) {
            // MCP server too old — emit `done` with success=true
            // so the UI doesn't show this as a failure. The card
            // also reads buildAttempted to suppress the row.
            emitStep("build", "done", {
              success: true,
              build_output: "(MCP server too old; build skipped)",
            });
          } else {
            buildAttempted = true;
            buildSuccess =
              buildResp.success === true || buildResp.exit_code === 0;
            buildOutput =
              (buildResp.stdout ?? "") +
              (buildResp.stderr ? "\n" + buildResp.stderr : "");
            emitStep("build", buildSuccess ? "done" : "error", {
              success: buildSuccess,
              build_output: truncate(buildOutput, 4_000),
              ...(buildSuccess ? {} : { error: buildResp.error }),
            });
          }
        }

        // ----- Step 5: start app + detect port + expose -----
        // Skipped when build was attempted and failed: a broken
        // build won't yield a meaningful preview, and the user
        // would just see a 502 cloudflared page.
        let appStarted = false;
        let appUrl: string | null = null;
        let appPort: number | null = null;
        if (
          cloneSuccess &&
          installSuccess &&
          (!buildAttempted || buildSuccess)
        ) {
          emitStep("app", "running");
          const start = await postExecute(session.tunnel_url, {
            type: "start_app",
            repo,
            command: startAppCommand(),
            cwd: SANDBOX_CLONE_DIR,
          });
          appStarted = start.started === true;

          if (appStarted) {
            const probe = await postExecute(session.tunnel_url, {
              type: "run_command",
              repo,
              command: portDetectCommand(),
            });
            const probeOut = (probe.stdout ?? "").trim();
            if (probe.exit_code === 0 && probeOut) {
              const last = probeOut
                .split(/\n/)
                .map((s) => s.trim())
                .filter(Boolean)
                .pop();
              const n = last ? Number(last) : NaN;
              if (Number.isFinite(n)) appPort = n;
            }

            if (appPort) {
              const expose = await postExecute(session.tunnel_url, {
                type: "expose_port",
                repo,
                port: appPort,
              });
              appUrl = typeof expose.url === "string" ? expose.url : null;
            }
          }

          emitStep("app", appStarted ? "done" : "error", {
            success: appStarted,
            url: appUrl,
          });
        }

        // ----- Aggregate -----
        const verdict = computeVerdict({
          cloneSuccess,
          installSuccess,
          testsPassed,
          testsFailed,
          noTests,
          buildAttempted,
          buildSuccess,
          appStarted,
          appUrl,
        });
        const overallDb = verdictToDbOverall(verdict);
        const duration_ms = Date.now() - startedAt;

        // Persist. Best-effort — a DB error here must not eat the
        // SSE "complete" event the UI is waiting for. We map the
        // rich verdict to the legacy enum because migration 015's
        // CHECK constraint forbids the new values; the rich
        // verdict survives in the SSE stream + the card.
        try {
          // Encode the build status into the test_output column
          // so the dashboard's chat report can still see "build
          // passed/failed" even though we don't have a column
          // for it. Mirrors devpod_tester.py.
          const persistedTestOutput = buildAttempted
            ? `[build: ${buildSuccess ? "pass" : "FAIL"}]\n` +
              (buildOutput ? `${buildOutput.slice(0, 2000)}\n---\n` : "") +
              testOutput
            : testOutput;

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
                test_output: truncate(persistedTestOutput),
                app_url: appUrl,
                app_started: appStarted,
                clone_success: cloneSuccess,
                install_success: installSuccess,
                overall: overallDb,
                duration_ms,
              },
              { onConflict: "repo,pr_number" },
            );
        } catch (e) {
          console.warn(
            `[run-pr-tests] persist failed: ${(e as Error).message}`,
          );
        }

        emit({
          step: "complete",
          status: "done",
          overall: verdict,
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
