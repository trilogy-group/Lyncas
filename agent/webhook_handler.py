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
VENV_PYTHON = AGENT_DIR / ".venv" / "bin" / "python"


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


# --- Reviewer dispatch ----------------------------------------------------

def dispatch_review(repo: str, pr_number: int) -> int:
    """Spawn pr_reviewer.py scoped to one PR. Returns the child PID.

    Popen is intentionally fire-and-forget — the child outlives the
    HTTP response, GitHub gets its 200 immediately, and the spawned
    process inherits our stdout/stderr so its log lines flow into the
    same systemd journal as our own webhook lines. The parent does NOT
    wait() on the child; orphan reaping is systemd's job."""
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
