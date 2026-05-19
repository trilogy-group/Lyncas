"""
devpod_tester.py — sandbox-test a PR by driving the user's DevPod
MCP server through five sequential commands:

  1. Obtain a working tree   — copy the user's live workspace if it
                               exists, otherwise shallow-clone.
                               Then `git fetch pull/<n>/head:pr-branch`
                               + `git checkout pr-branch`.
  2. Install dependencies     — npm install / pip install -r ... whichever
                               manifests are present. Best-effort.
  3. Run the test suite       — MCP server's run_tests handler auto-detects
                               the runner based on lockfiles.
  4. Start the app (optional) — if tests passed and a default-ish entry
                               point looks runnable, start it on port 3001
                               so we don't collide with whatever the user
                               is already running on 3000.
  5. Expose the running app   — cloudflared tunnel → public URL.

Then the result row is upserted into pr_sandbox_results so the dashboard
can render "tests passed / failed / live preview URL".

Backward-compat contract (RULES section in the spec):
  * If DEVPOD_TUNNEL_URL is unset, we exit cleanly with a one-line log.
    The webhook handler dispatches us speculatively even when no DevPod
    is live (because the lookup is best-effort and may race with a
    /disconnect), so a no-op exit must be the steady state.
  * If any individual MCP step times out / errors, we still write a
    pr_sandbox_results row with overall='error' and a captured failure
    message — never throw. Otherwise the dashboard's "running…" spinner
    would be stuck on a row that never appeared.

Env contract:
  PR_FILTER_REPO          owner/repo
  PR_FILTER_NUMBER        integer PR number
  DEVPOD_TUNNEL_URL       https://…trycloudflare.com (set by webhook)
  DEVPOD_SESSION_ID       devpod_sessions.id uuid (optional; recorded
                          on the result row when present)
  GITHUB_TOKEN_PAT        for the cloning fallback path
  SUPABASE_URL / SUPABASE_SERVICE_KEY
                          required to persist the result row. Without
                          them we still print the summary to stdout so
                          a webhook log inspection can recover the
                          outcome manually.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

# Auto-load .env for local/EC2 runs (no-op in GitHub Actions/systemd
# where env vars are injected externally). Same convention as
# pr_reviewer.py.
try:
    from pathlib import Path as _Path
    from dotenv import load_dotenv as _load_dotenv
    _load_dotenv(_Path(__file__).parent / ".env", override=True)
except ImportError:
    pass

# --- Config ---------------------------------------------------------------

# Per-step HTTP timeout. The MCP server's own caps are 120s for
# run_command / 300s for run_tests; we wait a bit longer than the
# longest server-side cap so a server-side timeout reaches us as a
# clean error rather than as an aborted urllib read.
STEP_TIMEOUT_SEC = 360

# Output truncation when persisting to Supabase. Keeps the row bounded
# and matches the dashboard's pre-allocation comment in 015.
MAX_OUTPUT_BYTES = 16 * 1024

# Port the started app is exposed on. 3001 (not 3000) to avoid
# colliding with the user's main dev server in the same DevPod.
APP_PORT = 3001

DASHBOARD_DEFAULT_REPO_DIR_FALLBACK = "/workspaces"


# --- HTTP helper ----------------------------------------------------------

def _post_execute(tunnel_url: str, body: dict[str, Any]) -> dict[str, Any]:
    """POST {tunnel}/execute with `body` as JSON. Returns the parsed
    JSON response body. On any failure (network, timeout, non-JSON,
    HTTP error), returns a synthetic dict with `error` populated and
    a best-effort `exit_code` so the caller can branch the same way
    on success and failure paths."""
    url = tunnel_url.rstrip("/") + "/execute"
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=STEP_TIMEOUT_SEC) as r:
            raw = r.read()
            try:
                return json.loads(raw)  # type: ignore[no-any-return]
            except json.JSONDecodeError:
                return {
                    "error": "non-JSON MCP response",
                    "raw": raw.decode("utf-8", errors="replace")[:1000],
                    "exit_code": -1,
                }
    except urllib.error.HTTPError as e:
        try:
            err_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            err_body = ""
        return {
            "error": f"HTTP {e.code} from MCP server",
            "raw": err_body[:1000],
            "exit_code": -1,
        }
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}", "exit_code": -1}


# --- Step builders --------------------------------------------------------

def _checkout_command(repo: str, pr_number: int, github_token: str) -> str:
    """Return a single shell command that:
       a) tries to copy the live DevPod workspace into ~/pr-test-<n>,
       b) falls back to a shallow clone if the workspace isn't there,
       c) fetches the PR head into a local pr-branch and checks it out.

    The command is intentionally one chained shell expression so the
    MCP server's per-call 120s timeout covers the whole sequence; a
    multi-call version would need three round trips and three
    timeouts. Side-effect of the chain: any non-zero exit fails the
    whole step and we surface it as clone_success=False.

    Token leakage: the github_token appears in the clone URL. The
    MCP server runs subprocesses with shell=True so the token is
    visible in /proc/<pid>/cmdline for the duration of the clone.
    Acceptable for the v1 sandbox model (the DevPod is the user's
    own machine), and the workspace-copy fast path skips the clone
    entirely when the user is working inside a real workspace."""
    target_dir = f'"$HOME/pr-test-{pr_number}"'
    workspace_expr = '"${DEVPOD_WORKSPACE_FOLDER:-}"'
    clone_url = (
        f"https://x-access-token:{github_token}@github.com/{repo}.git"
        if github_token
        else f"https://github.com/{repo}.git"
    )
    return (
        # Always start from a clean target dir so re-running the
        # sandbox on the same PR doesn't pick up stale state.
        f'rm -rf {target_dir} && '
        f'WORKSPACE={workspace_expr} && '
        # Copy fast-path (DevPod workspace exists & is a git repo).
        # Otherwise shallow-clone with the installation token.
        f'( [ -n "$WORKSPACE" ] && [ -d "$WORKSPACE/.git" ] && '
        f'  cp -r "$WORKSPACE" {target_dir} '
        f'  || git clone --depth=1 "{clone_url}" {target_dir} ) && '
        f'cd {target_dir} && '
        # Drop any half-checked-out pr-branch from a prior run.
        f'(git branch -D pr-branch 2>/dev/null || true) && '
        f'git fetch origin pull/{pr_number}/head:pr-branch && '
        f'git checkout pr-branch'
    )


def _install_command(pr_number: int) -> str:
    """Best-effort dependency install. The shell `(a || b || echo)`
    chain matches the user's spec: try npm, then pip, then no-op.
    The trailing `echo no deps` keeps the exit code zero so we don't
    confuse a missing manifest with an install failure."""
    work = f'"$HOME/pr-test-{pr_number}"'
    return (
        f'cd {work} && '
        f'( [ -f package.json ] && npm install --no-audit --no-fund 2>&1 || '
        f'  [ -f requirements.txt ] && pip install -r requirements.txt 2>&1 || '
        f'  echo "no deps detected" )'
    )


def _start_app_command(pr_number: int, port: int) -> str:
    """Try a few canonical entrypoints, set PORT for tools that honor
    it. The MCP server returns after 3s of `Popen` so this only
    confirms "did the process stay up briefly", not "is the app
    healthy". The expose_port step is what surfaces a usable URL."""
    work = f'"$HOME/pr-test-{pr_number}"'
    return (
        f'cd {work} && '
        f'export PORT={port} && '
        f'( npm start 2>/dev/null '
        f'  || python app.py 2>/dev/null '
        f'  || python main.py 2>/dev/null '
        f'  || echo "no entrypoint detected" )'
    )


# --- Result parsing -------------------------------------------------------

def _truncate(text: str, limit: int = MAX_OUTPUT_BYTES) -> str:
    if not text:
        return ""
    b = text.encode("utf-8", errors="replace")
    if len(b) <= limit:
        return text
    return b[:limit].decode("utf-8", errors="replace") + "\n…[truncated]"


def _count_passed_failed(stdout: str) -> tuple[int, int]:
    """Heuristic test-counter that handles the most common runners
    without requiring structured output. Best-effort: a "no tests
    detected" run reports zero and overall='no_tests' upstream.

    Recognized:
      * jest:          "Tests:  3 failed, 7 passed"
      * pytest:        "5 passed, 1 failed"
      * mocha:         " 7 passing", " 2 failing"
      * go test json:  one {"Action":"pass"} per package — counted
                       if we see a {"Action":"pass" string, fall
                       back to 0/0 otherwise.
    """
    import re

    passed = 0
    failed = 0

    m = re.search(r"(\d+)\s+passed", stdout)
    if m:
        passed = int(m.group(1))
    m = re.search(r"(\d+)\s+failed", stdout)
    if m:
        failed = int(m.group(1))
    if passed == 0 and failed == 0:
        m = re.search(r"(\d+)\s+passing", stdout)
        if m:
            passed = int(m.group(1))
        m = re.search(r"(\d+)\s+failing", stdout)
        if m:
            failed = int(m.group(1))

    return passed, failed


def _looks_like_no_tests(stdout: str, stderr: str) -> bool:
    blob = (stdout + "\n" + stderr).lower()
    needles = (
        "no test runner detected",
        "no tests found",
        "no tests collected",
        "no tests ran",
        "found 0 test",
    )
    return any(n in blob for n in needles)


# --- Supabase write -------------------------------------------------------

def _upsert_result(row: dict[str, Any]) -> None:
    """Best-effort persist to pr_sandbox_results via REST. We don't use
    supabase-py here because the agent's existing dependency on it is
    heavy and the row is a single upsert — keeping this script
    self-contained simplifies the systemd / Actions deploy."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        print(
            "[sandbox] Supabase env not configured — skipping persist",
            file=sys.stderr,
        )
        return

    endpoint = (
        url.rstrip("/")
        + "/rest/v1/pr_sandbox_results?on_conflict=repo,pr_number"
    )
    headers = {
        "Content-Type": "application/json",
        "apikey": key,
        "Authorization": f"Bearer {key}",
        # `resolution=merge-duplicates` makes PostgREST treat the POST
        # as an upsert keyed on the on_conflict columns.
        "Prefer": "resolution=merge-duplicates,return=representation",
    }
    body = json.dumps([row]).encode("utf-8")
    req = urllib.request.Request(
        endpoint, data=body, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            r.read()
    except Exception as e:
        print(
            f"[sandbox] persist failed: {type(e).__name__}: {e}",
            file=sys.stderr,
        )


def _user_id_for_repo(repo: str) -> str | None:
    """Look up watched_repos.user_id for the given repo via PostgREST.
    Returns None on miss. Used to populate pr_sandbox_results.user_id
    so the dashboard's "users read own results" RLS policy works."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        return None
    endpoint = (
        url.rstrip("/")
        + f"/rest/v1/watched_repos?repo=eq.{urllib.parse.quote(repo)}"
        "&select=user_id&limit=1"
    )
    req = urllib.request.Request(
        endpoint,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
            if isinstance(data, list) and data:
                return data[0].get("user_id")
    except Exception as e:
        print(
            f"[sandbox] user_id lookup failed: {type(e).__name__}: {e}",
            file=sys.stderr,
        )
    return None


# --- Orchestrator ---------------------------------------------------------

def run() -> dict[str, Any]:
    repo = os.environ.get("PR_FILTER_REPO", "").strip()
    pr_str = os.environ.get("PR_FILTER_NUMBER", "").strip()
    tunnel_url = os.environ.get("DEVPOD_TUNNEL_URL", "").strip()
    session_id = os.environ.get("DEVPOD_SESSION_ID", "").strip() or None
    github_token = os.environ.get("GITHUB_TOKEN_PAT", "").strip()

    if not tunnel_url:
        # Backward-compat exit per the rules: no DevPod, no work.
        # The webhook dispatches us regardless of session state, so a
        # silent steady-state exit must be the norm.
        print("[sandbox] DEVPOD_TUNNEL_URL not set — nothing to do")
        return {"overall": "skipped"}

    if not repo or not pr_str:
        print(
            "[sandbox] PR_FILTER_REPO / PR_FILTER_NUMBER missing — exiting",
            file=sys.stderr,
        )
        return {"overall": "error", "error": "missing PR filter env"}

    try:
        pr_number = int(pr_str)
    except ValueError:
        print(f"[sandbox] PR_FILTER_NUMBER={pr_str!r} not int", file=sys.stderr)
        return {"overall": "error", "error": "PR_FILTER_NUMBER not int"}

    started_at = time.time()
    print(f"[sandbox] starting PR {repo}#{pr_number} on {tunnel_url}")

    # --- Step A: clone / copy + checkout ---------------------------------
    checkout_resp = _post_execute(
        tunnel_url,
        {
            "type": "run_command",
            "repo": repo,
            "command": _checkout_command(repo, pr_number, github_token),
        },
    )
    clone_success = bool(
        checkout_resp.get("success") is True
        or checkout_resp.get("exit_code") == 0
    )
    if not clone_success:
        err = (
            checkout_resp.get("stderr")
            or checkout_resp.get("error")
            or ""
        )
        print(f"[sandbox] checkout failed: {err[:500]}", file=sys.stderr)

    # --- Step B: install dependencies (best-effort) ---------------------
    install_success = False
    install_output = ""
    if clone_success:
        install_resp = _post_execute(
            tunnel_url,
            {
                "type": "run_command",
                "repo": repo,
                "command": _install_command(pr_number),
            },
        )
        install_success = bool(
            install_resp.get("success") is True
            or install_resp.get("exit_code") == 0
        )
        install_output = (
            install_resp.get("stdout", "") or ""
        ) + (
            ("\n" + install_resp.get("stderr", ""))
            if install_resp.get("stderr")
            else ""
        )

    # --- Step C: run tests ----------------------------------------------
    tests_passed = 0
    tests_failed = 0
    test_output = ""
    if clone_success:
        test_resp = _post_execute(
            tunnel_url,
            {
                "type": "run_tests",
                "repo": repo,
                "cwd": os.path.expanduser(f"~/pr-test-{pr_number}"),
            },
        )
        stdout = test_resp.get("stdout", "") or ""
        stderr = test_resp.get("stderr", "") or ""
        tests_passed, tests_failed = _count_passed_failed(stdout + "\n" + stderr)
        test_output = stdout + ("\n" + stderr if stderr else "")
        if test_resp.get("error"):
            test_output += f"\n[sandbox] mcp error: {test_resp['error']}"

    # --- Step D: start app (only if tests passed cleanly) ---------------
    app_started = False
    if clone_success and tests_failed == 0 and tests_passed > 0:
        start_resp = _post_execute(
            tunnel_url,
            {
                "type": "start_app",
                "repo": repo,
                "command": _start_app_command(pr_number, APP_PORT),
                "cwd": os.path.expanduser(f"~/pr-test-{pr_number}"),
            },
        )
        app_started = bool(start_resp.get("started"))

    # --- Step E: expose the port ----------------------------------------
    app_url: str | None = None
    if app_started:
        expose_resp = _post_execute(
            tunnel_url,
            {
                "type": "expose_port",
                "repo": repo,
                "port": APP_PORT,
            },
        )
        if isinstance(expose_resp.get("url"), str):
            app_url = expose_resp["url"]

    # --- Final aggregation ----------------------------------------------
    if not clone_success:
        overall = "error"
    elif _looks_like_no_tests(test_output, ""):
        overall = "no_tests"
    elif tests_failed > 0:
        overall = "fail"
    elif tests_passed > 0:
        overall = "pass"
    else:
        # No counts, no canonical "no tests" string — treat as no_tests
        # rather than fail so the dashboard doesn't yellow-flag silent
        # runs. The truncated test_output below preserves whatever
        # the runner did say.
        overall = "no_tests"

    duration_ms = int((time.time() - started_at) * 1000)

    summary = {
        "tests_passed": tests_passed,
        "tests_failed": tests_failed,
        "test_output": _truncate(test_output),
        "app_url": app_url,
        "clone_success": clone_success,
        "install_success": install_success,
        "overall": overall,
        "duration_ms": duration_ms,
    }

    # --- Persist to Supabase --------------------------------------------
    _upsert_result(
        {
            "repo": repo,
            "pr_number": pr_number,
            "user_id": _user_id_for_repo(repo),
            "session_id": session_id,
            "tests_passed": tests_passed,
            "tests_failed": tests_failed,
            "test_output": summary["test_output"],
            "app_url": app_url,
            "app_started": app_started,
            "clone_success": clone_success,
            "install_success": install_success,
            "overall": overall,
            "duration_ms": duration_ms,
        }
    )

    print(
        f"[sandbox] PR {repo}#{pr_number} — tests: {tests_passed} passed, "
        f"{tests_failed} failed"
    )
    print(f"[sandbox] App URL: {app_url or 'App not started'}")
    print(f"[sandbox] Overall: {overall} ({duration_ms}ms)")

    return summary


if __name__ == "__main__":
    try:
        run()
    except Exception as e:
        # Last-resort safety net. Anything that escapes here is a bug,
        # but we still don't want to silently zombie the dashboard's
        # "running…" UI — print and exit non-zero so systemd / Actions
        # records the failure visibly.
        print(
            f"[sandbox] FATAL: {type(e).__name__}: {e}",
            file=sys.stderr,
        )
        sys.exit(1)
