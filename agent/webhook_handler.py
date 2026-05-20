"""
webhook_handler.py — standalone HTTP server that receives GitHub PR
webhooks and dispatches a targeted single-PR review by spawning
agent/pr_reviewer.py with PR_FILTER_REPO + PR_FILTER_NUMBER set.

When the agent runs on EC2 this REPLACES the Vercel Function +
workflow_dispatch chain. The review pipeline (LangGraph, prompt,
Supabase writes, auto-close gates) is the same — only the trigger
path changes.

Why this exists (vs the Vercel + Actions chain):
  * Median end-to-end latency drops from ~60–90s (Vercel function ->
    workflow_dispatch -> Actions cold-start -> pip install -> python
    pr_reviewer.py) to ~1–2s (TCP -> HMAC verify -> Popen). The
    reviewer's per-PR latency itself dominates either way, but the
    cold-start overhead disappears.
  * One less moving part to debug. No Vercel logs, no GitHub Actions
    queueing, just systemd + journalctl.

What this DELIBERATELY does NOT do:
  * It does NOT review the PR inline in this process. Same rule as
    the Vercel function (see CLAUDE.md § "Critical constraints"
    rule 3): there is exactly one place where reviews are produced —
    pr_reviewer.py via review_graph.py. The webhook only wakes it up.
  * It does NOT verify the PR is in REPOS. If GitHub delivers a
    webhook for a repo we don't normally watch, we still run the
    review when the operator wired up that webhook deliberately.
  * It does NOT block on the spawned reviewer. Popen returns the
    pid immediately and the 200 response goes back to GitHub well
    inside its 10s timeout.

Required env (loaded from agent/.env by start_webhook.sh or by the
systemd EnvironmentFile= directive):
  WEBHOOK_SECRET           — random string also pasted into the
                             GitHub webhook 'Secret' field. Required;
                             every request 401s when this is unset.
  ANTHROPIC_API_KEY        — passed through to the spawned reviewer.
  GITHUB_TOKEN_PAT         — passed through to the spawned reviewer.
  REPOS                    — passed through (the spawned reviewer
                             uses it only as a fallback when no
                             PR_FILTER_* is set, which the webhook
                             always sets, so this is purely for
                             startup-config logging).
  SUPABASE_URL             — passed through.
  SUPABASE_SERVICE_KEY     — passed through.

Optional env:
  WEBHOOK_PORT             — TCP port to listen on. Default 8080.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# --- Config ---------------------------------------------------------------

WEBHOOK_PORT = int(os.environ.get("WEBHOOK_PORT", "8080"))
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")

# Set of GitHub PR-event actions we actually review. Everything else
# (closed, edited, labeled, reviewed, ready_for_review, etc.) is a
# 200-no-op so the webhook UI still shows green deliveries.
REVIEWABLE_ACTIONS = {"opened", "synchronize"}

AGENT_DIR = Path(__file__).resolve().parent
REPO_ROOT = AGENT_DIR.parent
PR_REVIEWER_SCRIPT = AGENT_DIR / "pr_reviewer.py"
DEVPOD_TESTER_SCRIPT = AGENT_DIR / "devpod_tester.py"
REPORT_GENERATOR_SCRIPT = AGENT_DIR / "report_generator.py"
VENV_PYTHON = AGENT_DIR / ".venv" / "bin" / "python"

# Head-start the report generator gives the reviewer + sandbox before
# starting to poll Supabase for their result rows. The reviewer
# usually lands within ~30-60s on a webhook-triggered run; the
# sandbox is slower. 45s avoids the case where wait_for_data() spins
# its first few iterations on a row that doesn't exist yet, burning
# the poll budget needlessly. The generator's own wait_for_data still
# polls for up to 120s (reviewer) + 180s (sandbox) on top of this,
# so the delay is purely an optimization — correctness doesn't
# depend on it.
REPORT_GENERATOR_DELAY_SEC = 45


# --- HMAC verification ----------------------------------------------------

def verify_signature(raw_body: bytes, signature_header: str | None) -> bool:
    """HMAC-SHA256 of raw_body keyed with WEBHOOK_SECRET, compared
    constant-time against X-Hub-Signature-256. Mirrors the Vercel
    function's verifySignature() byte-for-byte so the same webhook
    Secret value works against both deployments without rotation.

    Returns False on missing secret (fail-closed — without the secret
    anyone with the public IP could trigger reviews at will) and on
    any header malformation."""
    if not WEBHOOK_SECRET:
        print(
            "[webhook] WEBHOOK_SECRET is not set — rejecting all deliveries",
            file=sys.stderr,
        )
        return False
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    expected = (
        "sha256="
        + hmac.new(
            WEBHOOK_SECRET.encode("utf-8"), raw_body, hashlib.sha256
        ).hexdigest()
    )
    # hmac.compare_digest works on equal-length strings; mismatched
    # lengths return False without raising, so no separate guard needed.
    return hmac.compare_digest(expected, signature_header)


# --- DevPod session lookup -----------------------------------------------

def get_active_devpod_session(repo: str) -> dict | None:
    """Return the live DevPod session for the user who owns `repo`,
    or None if there is no such session.

    Best-effort: any failure (Supabase down, schema mismatch, no
    SUPABASE_SERVICE_KEY in this environment) returns None so the
    review path proceeds unaffected. The whole point of the check
    is "speculatively dispatch a sandbox test if and only if it can
    plausibly succeed"; never let it block the review.

    Performs two cheap RPC calls:
      1. watched_repos for the repo → user_id (the row inserted by
         the dashboard's connect-repo flow).
      2. devpod_sessions for that user_id → tunnel_url + workspace_id,
         filtered to status='active' AND expires_at > now() so a
         crashed CLI's stale row doesn't dispatch a tester that
         immediately times out."""
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not supabase_url or not supabase_key:
        return None
    try:
        # Imported lazily so the webhook starts up cleanly on hosts
        # where supabase-py isn't installed (e.g. a webhook-only
        # systemd unit). The reviewer process imports it normally.
        from supabase import create_client  # type: ignore[import-not-found]

        sb = create_client(supabase_url, supabase_key)

        repo_row = (
            sb.table("watched_repos")
            .select("user_id")
            .eq("repo", repo)
            .limit(1)
            .execute()
        )
        rows = getattr(repo_row, "data", None) or []
        if not rows:
            return None
        user_id = rows[0].get("user_id")
        if not user_id:
            return None

        from datetime import datetime, timezone
        now_iso = datetime.now(timezone.utc).isoformat()

        session_row = (
            sb.table("devpod_sessions")
            .select("id, tunnel_url, workspace_id")
            .eq("user_id", user_id)
            .eq("status", "active")
            .gt("expires_at", now_iso)
            .limit(1)
            .execute()
        )
        srows = getattr(session_row, "data", None) or []
        return srows[0] if srows else None
    except Exception as e:
        # Wide except by design — a malformed supabase response or a
        # missing devpod_sessions table (migration not applied yet)
        # must NOT take down the webhook.
        print(
            f"[webhook] devpod session lookup failed: "
            f"{type(e).__name__}: {e}",
            file=sys.stderr,
        )
        return None


# --- Report generator (delayed) ------------------------------------------

def _spawn_report_delayed(env: dict, delay: int) -> None:
    """Sleep `delay` seconds, then Popen the report generator.
    Runs inside a daemon Thread spawned from dispatch_review.

    Rationale for threading vs the more obvious approach of "let the
    spawned report_generator.py sleep at its own startup": pushing
    the sleep into the child means we'd hold a python process idle
    for 45 seconds on every webhook delivery, which is wasteful on
    a small EC2 box. Doing it in a thread means the cost is one
    OS thread (sub-MB) for 45s, then a fresh interpreter for the
    real work — same end state, an order of magnitude lighter.

    The thread is daemon=True (caller passes daemon=True at start)
    so a SIGTERM to the webhook server doesn't dangle a half-asleep
    spawn. On systemd reload the in-flight reports are simply lost;
    the webhook will redeliver any 'opened' / 'synchronize' event
    that didn't get a 200, and the reviewer's idempotency marker
    on the PR comment will keep it from double-reviewing."""
    time.sleep(delay)
    if not REPORT_GENERATOR_SCRIPT.exists():
        print(
            f"[webhook] report generator script missing at "
            f"{REPORT_GENERATOR_SCRIPT}; skipping",
            file=sys.stderr,
        )
        return
    repo_label = env.get("PR_FILTER_REPO", "?")
    pr_label = env.get("PR_FILTER_NUMBER", "?")
    try:
        proc = subprocess.Popen(
            [str(VENV_PYTHON), str(REPORT_GENERATOR_SCRIPT)],
            cwd=str(REPO_ROOT),
            env=env,
            stdout=sys.stdout,
            stderr=sys.stderr,
        )
        print(
            f"[webhook] dispatched report generator for "
            f"{repo_label}#{pr_label} (report_pid={proc.pid})"
        )
    except Exception as e:
        # Mirrors the sandbox dispatch error path — a missing venv
        # python or a bad script must not crash the webhook server.
        print(
            f"[webhook] report generator dispatch failed: "
            f"{type(e).__name__}: {e}",
            file=sys.stderr,
        )


# --- Reviewer + sandbox dispatch -----------------------------------------

def dispatch_review(repo: str, pr_number: int) -> int:
    """Spawn pr_reviewer.py scoped to one PR. Returns the child PID.

    If the PR-owning user has an active DevPod session, ALSO spawn
    devpod_tester.py with the tunnel URL pre-filled. Both children
    run in parallel — the reviewer's LangGraph review and the
    sandbox's clone-install-test sequence have no shared state and
    write to different Supabase tables. Either may finish first; the
    dashboard renders whichever rows are present.

    Popen is intentionally fire-and-forget — both children outlive
    the HTTP response, GitHub gets its 200 immediately, and they
    inherit our stdout/stderr so their log lines flow into the same
    systemd journal as our own webhook lines. The parent does NOT
    wait() on either; orphan reaping is systemd's job."""
    env = os.environ.copy()
    env["PR_FILTER_REPO"] = repo
    env["PR_FILTER_NUMBER"] = str(pr_number)
    # Distinguish webhook-triggered runs from cron / workflow_dispatch
    # ones in the Supabase `runs.trigger_source` column. The reviewer
    # reads this var when inserting the run row.
    env["GITHUB_EVENT_NAME"] = "webhook"
    proc = subprocess.Popen(
        [str(VENV_PYTHON), str(PR_REVIEWER_SCRIPT)],
        cwd=str(REPO_ROOT),
        env=env,
        stdout=sys.stdout,
        stderr=sys.stderr,
    )

    # Speculative sandbox dispatch. Run AFTER the reviewer Popen so a
    # slow Supabase lookup never delays the review's start.
    devpod_session = get_active_devpod_session(repo)
    if devpod_session and DEVPOD_TESTER_SCRIPT.exists():
        sandbox_env = {
            **env,
            "DEVPOD_TUNNEL_URL": devpod_session.get("tunnel_url", ""),
            "DEVPOD_SESSION_ID": str(devpod_session.get("id", "")),
        }
        try:
            sandbox_proc = subprocess.Popen(
                [str(VENV_PYTHON), str(DEVPOD_TESTER_SCRIPT)],
                cwd=str(REPO_ROOT),
                env=sandbox_env,
                stdout=sys.stdout,
                stderr=sys.stderr,
            )
            print(
                f"[webhook] dispatched sandbox test for {repo}#{pr_number} "
                f"(DevPod: {devpod_session.get('workspace_id', 'unknown')}, "
                f"sandbox_pid={sandbox_proc.pid})"
            )
        except Exception as e:
            # Don't fail the response if the sandbox script can't be
            # exec'd — review still succeeds.
            print(
                f"[webhook] sandbox dispatch failed: "
                f"{type(e).__name__}: {e}",
                file=sys.stderr,
            )

    # Report generator. Fires regardless of whether the sandbox was
    # dispatched — a report can still be useful from the review row
    # alone (it'll just show "sandbox: not_run" in the body). The
    # 45s delay lets the reviewer and sandbox accumulate something
    # to synthesize from before the generator starts polling.
    if REPORT_GENERATOR_SCRIPT.exists():
        # Pass through ANTHROPIC_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_KEY
        # + GITHUB_TOKEN (or _PAT). They're already on env from
        # os.environ.copy(); we just need to forward them as-is.
        # PR_FILTER_REPO / PR_FILTER_NUMBER are already set above.
        report_env = dict(env)
        t = threading.Thread(
            target=_spawn_report_delayed,
            args=(report_env, REPORT_GENERATOR_DELAY_SEC),
            daemon=True,
            name=f"report-{repo}#{pr_number}",
        )
        t.start()
        print(
            f"[webhook] scheduled report generator for {repo}#{pr_number} "
            f"in {REPORT_GENERATOR_DELAY_SEC}s"
        )
    return proc.pid


# --- HTTP handler ---------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    """One Handler instance per request (BaseHTTPRequestHandler
    convention). ThreadingHTTPServer creates a fresh thread per
    request so a slow body read can't block /health checks."""

    # Silence the default access-log format — we emit our own
    # structured [webhook] lines instead.
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        return

    def _json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except BrokenPipeError:
            # Client hung up before we could finish writing. Not our
            # problem — GitHub aggressively times out unhealthy
            # deliveries and retries, which is the right behavior.
            pass

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"status": "ok"})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        try:
            if self.path != "/api/webhook/pull-request":
                self._json(404, {"error": "not found"})
                return

            length_header = self.headers.get("Content-Length")
            try:
                length = int(length_header or 0)
            except ValueError:
                self._json(400, {"error": "invalid Content-Length"})
                return
            raw_body = self.rfile.read(length) if length > 0 else b""

            signature = self.headers.get("X-Hub-Signature-256")
            if not verify_signature(raw_body, signature):
                print("[webhook] 401 invalid signature", file=sys.stderr)
                self._json(401, {"error": "invalid signature"})
                return

            event = self.headers.get("X-GitHub-Event", "")
            if event == "ping":
                print("[webhook] POST /api/webhook/pull-request event=ping")
                self._json(200, {"pong": True})
                return

            if event != "pull_request":
                print(
                    f"[webhook] POST /api/webhook/pull-request "
                    f"event={event!r} ignored"
                )
                self._json(200, {"ignored": event or "unknown"})
                return

            try:
                payload = json.loads(raw_body or b"{}")
            except json.JSONDecodeError:
                self._json(400, {"error": "invalid JSON body"})
                return

            action = payload.get("action")
            if action not in REVIEWABLE_ACTIONS:
                print(
                    f"[webhook] POST /api/webhook/pull-request "
                    f"action={action!r} ignored"
                )
                self._json(200, {"ignored": action or "no_action"})
                return

            repo = (payload.get("repository") or {}).get("full_name")
            pr = payload.get("pull_request") or {}
            pr_number = pr.get("number")

            if not repo or not isinstance(pr_number, int):
                self._json(
                    400,
                    {
                        "error": "missing repository.full_name or "
                                 "pull_request.number"
                    },
                )
                return

            print(
                f"[webhook] POST /api/webhook/pull-request "
                f"action={action} repo={repo} pr={pr_number}"
            )
            pid = dispatch_review(repo, pr_number)
            print(
                f"[webhook] dispatched review for {repo}#{pr_number} "
                f"(pid={pid})"
            )
            self._json(200, {"ok": True, "queued": True, "pid": pid})
        except Exception as e:
            # Never let an uncaught exception kill the server thread.
            # The HTTP server is meant to outlive any individual bad
            # payload — GitHub will retry transient 5xx anyway.
            err = f"{type(e).__name__}: {e}"
            print(f"[webhook] 500 unhandled error: {err}", file=sys.stderr)
            try:
                self._json(500, {"error": err})
            except Exception:
                pass


# --- Main -----------------------------------------------------------------

def main() -> int:
    print(
        f"[webhook] starting on 0.0.0.0:{WEBHOOK_PORT} "
        f"(reviewer={PR_REVIEWER_SCRIPT}, cwd={REPO_ROOT})"
    )
    if not WEBHOOK_SECRET:
        print(
            "[webhook] WARNING: WEBHOOK_SECRET not set — every request "
            "will return 401",
            file=sys.stderr,
        )
    if not PR_REVIEWER_SCRIPT.exists():
        print(
            f"[webhook] FATAL: reviewer script not found at "
            f"{PR_REVIEWER_SCRIPT}",
            file=sys.stderr,
        )
        return 2

    server = ThreadingHTTPServer(("0.0.0.0", WEBHOOK_PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[webhook] shutting down on KeyboardInterrupt")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
