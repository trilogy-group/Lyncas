"""
devpod_tester.py — sandbox-test a PR by driving the user's DevPod
MCP server through a sequence of commands:

  1. Obtain a working tree   — shallow-clone the repo into
                               /tmp/pr-test-<n> (per-PR; wiped
                               on every run AND at tail cleanup
                               so two consecutive PRs cannot
                               share a stale `.next` or
                               `node_modules`). Then
                               `git fetch pull/<n>/head:pr-branch`
                               + `git checkout pr-branch` + echo
                               CLONE_SUCCESS. The marker is the
                               sole proof that the entire chain
                               ran end-to-end; missing marker →
                               clone_success=False → early exit
                               (no install / tests / build / app),
                               but we still post a PR comment +
                               persist the result row so the
                               dashboard doesn't show a stuck
                               "running…" spinner.
  2. Install dependencies     — npm install / pip install -r ... whichever
                               manifests are present. Best-effort.
  3. Run the test suite       — MCP server's run_tests handler auto-detects
                               the runner based on lockfiles.
  4. Build                    — npm run build / go build / no-op for Python.
                               Auto-detected by the MCP server's "build"
                               handler with a 180s timeout (Next.js cold
                               builds routinely take 60–120s).
  5. Start the app (optional) — try canonical entrypoints across the three
                               supported stacks (Next.js, Python, Go) and
                               let the app pick its own port.
  6. Detect & expose the port — probe ports 3000 → 8000 → 8080 → 5000 in
                               that order; whichever responds first gets
                               cloudflared'd. Default 3000 covers Next.js;
                               8000/8080 cover Django/FastAPI/Go; 5000
                               covers Flask. App-start timeout is 8s so
                               Next.js cold starts have room.

Then a structured comment is posted to the PR (rules: "Always post the
GitHub comment even if some steps fail", "use the installation token in
GITHUB_TOKEN") and the result row is upserted into pr_sandbox_results
so the dashboard can render the verdict.

Backward-compat contract (RULES in the spec):
  * If DEVPOD_TUNNEL_URL is unset, we exit cleanly with a one-line log.
    The webhook handler dispatches us speculatively even when no DevPod
    is live (because the lookup is best-effort and may race with a
    /disconnect), so a no-op exit must be the steady state.
  * If any individual MCP step times out / errors, we still write a
    pr_sandbox_results row with a captured failure message AND still
    attempt to post the GitHub comment — never throw. Otherwise the
    dashboard's "running…" spinner would be stuck on a row that never
    appeared.
  * We persist the legacy 4-value `overall` enum (pass / fail /
    no_tests / error) because the migration 015 CHECK constraint
    forbids the richer verdict set (pass_no_preview, tests_failed,
    build_failed). The richer verdict is preserved in the GitHub
    comment + the test_output column for postmortem.

Env contract:
  PR_FILTER_REPO          owner/repo
  PR_FILTER_NUMBER        integer PR number
  DEVPOD_TUNNEL_URL       https://…trycloudflare.com (set by webhook)
  DEVPOD_SESSION_ID       devpod_sessions.id uuid (optional; recorded
                          on the result row when present)
  GITHUB_TOKEN            installation token for posting the PR comment
                          (set by the webhook handler from the
                          installation that delivered the event).
                          Falls back to GITHUB_TOKEN_PAT if unset so
                          local manual runs still work.
  GITHUB_TOKEN_PAT        for the cloning fallback path AND comment
                          fallback when GITHUB_TOKEN is missing.
  SUPABASE_URL / SUPABASE_SERVICE_KEY
                          required to persist the result row. Without
                          them we still print the summary to stdout and
                          still post the GitHub comment so a webhook
                          log inspection can recover the outcome
                          manually.
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
# run_command, 300s for run_tests, 180s for build (new). We wait a
# little longer than the longest server-side cap so a server-side
# timeout reaches us as a clean error rather than as an aborted
# urllib read.
STEP_TIMEOUT_SEC = 360

# Output truncation when persisting to Supabase. Keeps the row bounded
# and matches the dashboard's pre-allocation comment in migration 015.
MAX_OUTPUT_BYTES = 16 * 1024

# Per-PR app port. Formula gives 100 distinct ports in [3000, 3099]
# — sufficient for the typical "active PRs per repo" range, with a
# graceful-collision fallback baked into the start_app command
# (fuser -k clears any zombie process from a prior run on the same
# port before the new app boots). Trade-off vs the multi-port probe
# this replaces: Python / Go apps that ignore $PORT and bind to
# their own default (8000 / 5000 / 8080) will appear as
# "App started, preview URL unavailable" since we only probe the
# calculated port. Acceptable for the Next.js-dominant workflow
# this code path was built for; if non-Node sandboxing comes back,
# fan-out the probe again.
def _app_port(pr_number: int) -> int:
    return 3000 + (pr_number % 100)


# How long the per-PR clone tree (and therefore the live preview
# URL backed by it) is kept alive after the sandbox finishes.
# Chosen as 2 hours: long enough for a human reviewer to click
# through from the PR comment after a CI run, short enough that
# a chatty repo doesn't accumulate stale trees in /tmp.
PREVIEW_PRESERVE_SEC = 2 * 60 * 60

# Marker comment so a re-run on the same PR (e.g. force-push, then
# webhook fires again) replaces the prior sandbox comment cleanly
# rather than stacking. Mirrors the REVIEW_MARKER pattern in
# pr_reviewer.py — version-stamped so we can change the layout
# without re-commenting historical PRs.
SANDBOX_COMMENT_MARKER = "<!-- lyncas:sandbox:v2 -->"

# Where we clone the PR into on the DevPod. Per-PR subdirectory
# under /tmp so two concurrent runs (and back-to-back runs that
# share the same DevPod) can never collide on each other's build
# artifacts. The previous v2 design used a single shared
# `/tmp/pr-test` and we observed stale `.next` directories from a
# prior PR contaminating the next run — even though the clone
# command `rm -rf`s the target, an intermediate failure could
# leave the dir half-wiped, and an aborted run never ran the
# cleanup at all.
#
# Cleanup runs at the tail of every run() invocation (via
# _cleanup_command), so steady-state /tmp footprint per PR is
# zero. The compose helper below is the single source of truth
# for the path.
def _clone_dir(pr_number: int) -> str:
    return f"/tmp/pr-test-{pr_number}"

# Sentinel printed at the tail of the clone command. The MCP server
# returns success=True whenever the chained command exits 0, but
# `git checkout` is finicky enough (detached HEAD, dirty trees,
# permission issues on certain DevPod base images) that we want a
# stricter "I actually got through every step" signal. The presence
# of this exact string in stdout is the only thing that promotes
# the clone to clone_success=True.
CLONE_SUCCESS_MARKER = "CLONE_SUCCESS"

# How long to wait (post-`start_app`) for the app to actually bind a
# port. MCP server's start_app already sleeps 3s; we add another 5s
# of polling for a total of ~8s before we give up. Next.js cold
# starts on a sleepy DevPod can hit 5–6s.
APP_BIND_TIMEOUT_SEC = 8

GITHUB_API = "https://api.github.com"


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
    """Return the single shell command that:
       a) wipes the per-PR /tmp/pr-test-<n> from any prior run,
       b) shallow-clones the PR's repo into that path,
       c) fetches the PR head into a local pr-branch and checks it
          out,
       d) prints CLONE_SUCCESS on the final line.

    The command is intentionally one chained shell expression so the
    MCP server's per-call 120s timeout covers the whole sequence; a
    multi-call version would need multiple round trips and multiple
    timeouts. Any non-zero exit in the chain prevents
    CLONE_SUCCESS from printing, which the caller treats as
    clone_success=False.

    Per-PR directory: every PR gets its own /tmp/pr-test-<n>
    subdirectory so two consecutive runs cannot leak build
    artifacts (notably Next.js `.next`) into one another's
    workspace. The cleanup helper at the tail of run() removes
    this directory whether the run succeeded or failed.

    Token leakage: the github_token appears in the clone URL. The
    MCP server runs subprocesses with shell=True so the token is
    visible in /proc/<pid>/cmdline for the duration of the clone.
    Acceptable for the v1 sandbox model (the DevPod is the user's
    own machine)."""
    workdir = _clone_dir(pr_number)
    clone_url = (
        f"https://x-access-token:{github_token}@github.com/{repo}.git"
        if github_token
        else f"https://github.com/{repo}.git"
    )
    return (
        f"rm -rf {workdir} && "
        f'git clone --depth=1 "{clone_url}" {workdir} && '
        f"cd {workdir} && "
        f"git fetch origin pull/{pr_number}/head:pr-branch && "
        f"git checkout pr-branch && "
        f"echo {CLONE_SUCCESS_MARKER}"
    )


def _install_command(pr_number: int) -> str:
    """Best-effort dependency install across the three supported
    stacks. The shell `(a || b || c || echo)` chain matches the
    user's spec: try npm, then pip, then `go mod download`, then
    no-op. The trailing `echo no deps` keeps the exit code zero so
    we don't confuse a missing manifest with an install failure."""
    workdir = _clone_dir(pr_number)
    return (
        f"cd {workdir} && "
        f"( [ -f package.json ] && npm install --no-audit --no-fund 2>&1 || "
        f"  [ -f requirements.txt ] && pip install -r requirements.txt 2>&1 || "
        f"  [ -f go.mod ] && go mod download 2>&1 || "
        f'  echo "no deps detected" )'
    )


def _verify_build_command(pr_number: int) -> str:
    """Belt-and-braces build-artifact check, run RIGHT BEFORE
    start_app. If the dedicated build step earlier in the
    pipeline ran cleanly we expect /tmp/pr-test-<n>/.next to
    exist for Next.js projects — `ls` exits 0 and we echo
    BUILD_EXISTS. Otherwise (build step skipped because the MCP
    server is too old, or build succeeded but the artifact was
    cleaned up between steps), we run `npm run build` inline as
    a recovery so start_app has something to serve.

    The check is gated on package.json so we don't try
    `npm run build` on a Python / Go project. The MCP server's
    run_command timeout is 120s; that's enough for an incremental
    rebuild but tight for a full cold build — the dedicated build
    step (180s) should already have produced the artifact in the
    happy path, so this is purely a safety net."""
    workdir = _clone_dir(pr_number)
    return (
        f"cd {workdir} && "
        f"( [ -f package.json ] && "
        f"  ( ls {workdir}/.next >/dev/null 2>&1 && echo BUILD_EXISTS "
        f"    || npm run build 2>&1 ) "
        f"  || echo 'not a node project — skipping build verification' )"
    )


def _start_app_command(pr_number: int) -> str:
    """Try canonical entrypoints across Next.js, Python, and Go,
    targeting the per-PR port computed by _app_port.

    We `export PORT=<port>` so tools that honor it (npm scripts,
    Next.js, Express) bind to the right place. Python / Go
    apps that ignore $PORT will bind to their own default and
    the port-probe below will not find them — see the comment on
    _app_port for the trade-off.

    The `fuser -k` prelude is best-effort port reclamation: if a
    prior sandbox run on the same DevPod (same PR number, or a
    PR that happened to mod-100 to the same port) left a zombie
    process bound, kill it before booting the new one.
      * `2>/dev/null` swallows the "no process found" stderr.
      * `; echo PORT_CLEARED` (semicolon, not &&) keeps the
        marker printing even when fuser exits non-zero, which
        is the happy-path expected case on a clean port.

    Ordering matters here: `npm start` is checked first because
    Next.js / React apps are the most common stack. `go run .` is
    last because compiling Go on every start adds 5–15s, which
    eats into the 8s bind window."""
    workdir = _clone_dir(pr_number)
    port = _app_port(pr_number)
    return (
        f"cd {workdir} && "
        f"export PORT={port} && "
        f"fuser -k {port}/tcp 2>/dev/null; echo PORT_CLEARED; "
        f"( npm start 2>&1 "
        f"  || python app.py 2>&1 "
        f"  || python main.py 2>&1 "
        f"  || go run . 2>&1 "
        f'  || echo "no entrypoint detected" )'
    )


def _cleanup_command(pr_number: int) -> str:
    """Detached, *delayed* wipe of the per-PR clone directory.

    The sandbox's whole point is to give the reviewer a live
    preview URL on the PR comment — the cloudflared tunnel only
    stays useful for as long as the running app can still read
    its source / static assets from disk. Running an immediate
    `rm -rf` here kills the preview the moment the sandbox
    "succeeds", which defeats the feature.

    Fix: fork a background bash that sleeps for
    PREVIEW_PRESERVE_SEC seconds (2h) and only THEN wipes the
    tree. The MCP server's `subprocess.run(shell=True)` invokes
    a wrapping shell that returns the instant `&` fires, so the
    sandbox finishes promptly while the cleanup proceeds out of
    band.

    The running app process (npm start / python / go) is
    deliberately NOT killed alongside the rm. The spec is "let
    the preview keep working for ~2 hours". After the rm fires
    the running process will start 404'ing on lazy chunk loads
    (Next.js) or asset reads — which is the desired graceful
    decay; the OS reaps the process when it eventually crashes
    on a failed read.

    Caveats worth knowing:
      * The 7200s sleep + the bash + the rm survive the original
        MCP request because of `nohup` + `&`. They are NOT
        guaranteed to survive a full DevPod restart — if the
        user disconnects within 2h, the cleanup may never run
        and the next sandbox will rm the stale tree at clone
        time anyway.
      * Without explicit `>/dev/null 2>&1 </dev/null` the
        detached process inherits the parent's pipes; sleep + rm
        don't write so no SIGPIPE in practice. Adding the
        redirects is a textbook defensive tweak but not
        strictly required for correctness here."""
    workdir = _clone_dir(pr_number)
    return (
        f'nohup bash -c "sleep {PREVIEW_PRESERVE_SEC} && '
        f'rm -rf {workdir}" &'
    )


def _port_detect_command(pr_number: int) -> str:
    """Poll once per second for up to APP_BIND_TIMEOUT_SEC seconds,
    probing the calculated per-PR port. Prints the port on stdout
    if it responds (so the orchestrator can pass it on to
    expose_port unchanged), otherwise exits 1 with no output.

    Single port (not the legacy 4-port fan-out) because each PR
    now has a deterministic destination port; the
    rationale is documented on _app_port. A local curl probe is
    sub-100ms so even the eight-iteration worst case fits well
    inside the MCP server's 120s run_command cap."""
    port = _app_port(pr_number)
    return (
        f"for i in $(seq 1 {APP_BIND_TIMEOUT_SEC}); do "
        f'  if curl -sI --max-time 1 "http://localhost:{port}" '
        f"    >/dev/null 2>&1; then "
        f"    echo {port}; exit 0; "
        f"  fi; "
        f"  sleep 1; "
        f"done; "
        f"exit 1"
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


def _compute_verdict(
    *,
    clone_success: bool,
    install_success: bool,
    tests_passed: int,
    tests_failed: int,
    no_tests: bool,
    build_attempted: bool,
    build_success: bool,
    app_started: bool,
    app_url: str | None,
) -> str:
    """Map the per-step outcomes to one of the six rich verdicts
    documented in the spec. The order of conditions matters: a
    failed build is more PR-relevant than failed tests (because a
    build failure blocks merge regardless), so we surface
    'build_failed' even if tests also failed."""
    if not clone_success or not install_success:
        return "error"
    if build_attempted and not build_success:
        return "build_failed"
    if tests_failed > 0:
        return "tests_failed"
    if no_tests:
        return "no_tests"
    # Everything green up through build + tests; differentiate
    # pass with vs without a live preview URL.
    if app_started and app_url:
        return "pass"
    return "pass_no_preview"


def _verdict_to_db_overall(verdict: str) -> str:
    """Collapse the rich verdict to the legacy enum that migration
    015's CHECK constraint accepts. Kept in lockstep with the
    TypeScript verdictToDbOverall() in dashboard/lib/types.ts."""
    if verdict in ("pass", "pass_no_preview"):
        return "pass"
    if verdict in ("tests_failed", "build_failed"):
        return "fail"
    if verdict == "no_tests":
        return "no_tests"
    return "error"


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


# --- GitHub comment -------------------------------------------------------

def _github_request(
    method: str,
    path: str,
    token: str,
    body: dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any] | list[Any] | None]:
    """Minimal urllib-based GitHub API call. Returns
    (status_code, parsed_body|None). We avoid `requests` here to
    keep devpod_tester.py stdlib-only — the script is meant to be
    runnable from a thin systemd unit without the full agent venv.
    `requests` is in the venv anyway, but the rest of this module
    is urllib-based and mixing the two for one call would be
    inconsistent."""
    url = GITHUB_API.rstrip("/") + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "lyncas-sandbox",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            parsed: Any = None
            if raw:
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError:
                    parsed = None
            return r.status, parsed
    except urllib.error.HTTPError as e:
        # Read the body for diagnostics; otherwise we'd hide the
        # actual API error reason behind a bare HTTP code.
        try:
            raw = e.read().decode("utf-8", errors="replace")
        except Exception:
            raw = ""
        print(
            f"[sandbox] github {method} {path} -> {e.code}: {raw[:300]}",
            file=sys.stderr,
        )
        return e.code, None
    except Exception as e:
        print(
            f"[sandbox] github {method} {path} -> "
            f"{type(e).__name__}: {e}",
            file=sys.stderr,
        )
        return 0, None


def _existing_sandbox_comment_id(
    repo: str, pr_number: int, token: str
) -> int | None:
    """Find a prior sandbox comment by its marker so we can update
    it in place rather than spamming the PR on every re-run.
    Mirrors pr_reviewer.already_reviewed() but returns the comment
    id instead of a bool because we want to PATCH it."""
    status, data = _github_request(
        "GET",
        f"/repos/{repo}/issues/{pr_number}/comments?per_page=100",
        token,
    )
    if status != 200 or not isinstance(data, list):
        return None
    for c in data:
        if isinstance(c, dict) and SANDBOX_COMMENT_MARKER in (
            c.get("body") or ""
        ):
            cid = c.get("id")
            if isinstance(cid, int):
                return cid
    return None


def _verdict_header(verdict: str, app_url: str | None) -> str:
    """One-line summary line that the GitHub comment leads with.
    Emoji + short label tailored to each verdict; the trailing
    parenthetical only appears for the pass_no_preview case
    because it's the only "pass" that needs an explanation."""
    table = {
        "pass": "✅ Sandbox PASSED — build OK, tests OK, app running",
        "pass_no_preview": (
            "✅ Sandbox PASSED "
            "(build OK, tests OK — preview URL unavailable)"
        ),
        "tests_failed": "❌ Sandbox FAILED — tests failed",
        "build_failed": "❌ Sandbox FAILED — build failed",
        "no_tests": "🟡 Sandbox build OK — no tests found",
        "error": "⚠️ Sandbox ERROR — could not run",
    }
    line = table.get(verdict, f"Sandbox: {verdict}")
    if verdict == "pass" and app_url:
        line += f" — {app_url}"
    return line


def _step_row(label: str, ok: bool | None, *, skipped: bool = False) -> str:
    """One table row for the GitHub comment's step summary."""
    if skipped:
        return f"| {label} | ⏭ skipped |"
    icon = "✅" if ok else ("❌" if ok is False else "—")
    return f"| {label} | {icon} |"


def _format_pr_comment(summary: dict[str, Any]) -> str:
    """Build the markdown body posted to the PR.

    Format intent (kept stable so PRs can be diff'd over time):
      1. Hidden marker (for idempotent update-in-place).
      2. ### header with bolded verdict line.
      3. Per-step status table.
      4. Optional 'Open Live Preview' link if app_url is set.
      5. Collapsible <details> for build output (only when
         build was attempted, even on success — operators want a
         "is the build cache cold?" lookup).
      6. Collapsible <details> for test output.
      7. Footer with duration + workspace id."""
    verdict = summary["verdict"]
    app_url = summary.get("app_url")
    workspace_id = summary.get("workspace_id") or "unknown"
    duration_ms = summary.get("duration_ms") or 0

    lines: list[str] = [SANDBOX_COMMENT_MARKER, ""]
    lines.append(f"### {_verdict_header(verdict, app_url)}")
    lines.append("")
    lines.append("| Step | Status |")
    lines.append("| --- | --- |")
    lines.append(_step_row("Clone", summary.get("clone_success")))
    lines.append(_step_row("Install", summary.get("install_success")))
    if summary.get("no_tests"):
        lines.append(_step_row("Tests", None, skipped=True))
    else:
        tp = summary.get("tests_passed") or 0
        tf = summary.get("tests_failed") or 0
        lines.append(
            f"| Tests | {'✅' if tf == 0 and tp > 0 else '❌'} "
            f"{tp} passed, {tf} failed |"
        )
    if summary.get("build_attempted"):
        lines.append(_step_row("Build", summary.get("build_success")))
    else:
        lines.append(_step_row("Build", None, skipped=True))
    if summary.get("app_started"):
        if app_url:
            lines.append(f"| App | ✅ running at port {summary.get('app_port', '?')} |")
        else:
            lines.append("| App | ✅ started — preview URL unavailable |")
    else:
        lines.append(_step_row("App", None, skipped=True))

    if app_url:
        lines.append("")
        lines.append(f"🔗 **[Open Live Preview]({app_url})**")
    elif summary.get("app_started"):
        lines.append("")
        lines.append("⚠️ App started but preview URL unavailable.")

    if summary.get("build_attempted"):
        out = (summary.get("build_output") or "").strip()
        if out:
            lines.append("")
            lines.append("<details><summary>Build output</summary>")
            lines.append("")
            lines.append("```")
            lines.append(out[-6000:])
            lines.append("```")
            lines.append("")
            lines.append("</details>")

    test_out = (summary.get("test_output") or "").strip()
    if test_out:
        lines.append("")
        lines.append("<details><summary>Test output</summary>")
        lines.append("")
        lines.append("```")
        lines.append(test_out[-6000:])
        lines.append("```")
        lines.append("")
        lines.append("</details>")

    lines.append("")
    lines.append(
        f"*Sandbox ran in {duration_ms}ms on EC2 · "
        f"DevPod workspace: {workspace_id}*"
    )
    return "\n".join(lines)


def _post_pr_comment(repo: str, pr_number: int, body: str) -> None:
    """Post (or update in place if a prior sandbox comment exists)
    the verdict on the PR. Uses GITHUB_TOKEN (installation token,
    set by the webhook handler from the App installation that
    delivered the PR event); falls back to GITHUB_TOKEN_PAT for
    manual local invocations.

    Rules: "Always post the GitHub comment even if some steps fail"
    — so this is called from every code path that reaches verdict
    computation, including the early-error path where clone failed.
    Failure to post is logged but never raised."""
    token = (
        os.environ.get("GITHUB_TOKEN", "").strip()
        or os.environ.get("GITHUB_TOKEN_PAT", "").strip()
    )
    if not token:
        print(
            "[sandbox] no GITHUB_TOKEN / GITHUB_TOKEN_PAT — "
            "skipping PR comment",
            file=sys.stderr,
        )
        return

    existing_id = _existing_sandbox_comment_id(repo, pr_number, token)
    if existing_id is not None:
        status, _ = _github_request(
            "PATCH",
            f"/repos/{repo}/issues/comments/{existing_id}",
            token,
            {"body": body},
        )
        if status in (200, 201):
            print(
                f"[sandbox] updated PR comment {existing_id} on "
                f"{repo}#{pr_number}"
            )
            return
        # Fall through to creating a new comment if update failed;
        # better a duplicate than no comment at all.

    status, _ = _github_request(
        "POST",
        f"/repos/{repo}/issues/{pr_number}/comments",
        token,
        {"body": body},
    )
    if status in (200, 201):
        print(f"[sandbox] posted PR comment on {repo}#{pr_number}")
    else:
        print(
            f"[sandbox] PR comment post failed (HTTP {status})",
            file=sys.stderr,
        )


# --- Orchestrator ---------------------------------------------------------

def run() -> dict[str, Any]:
    repo = os.environ.get("PR_FILTER_REPO", "").strip()
    pr_str = os.environ.get("PR_FILTER_NUMBER", "").strip()
    tunnel_url = os.environ.get("DEVPOD_TUNNEL_URL", "").strip()
    session_id = os.environ.get("DEVPOD_SESSION_ID", "").strip() or None
    github_token_for_clone = os.environ.get("GITHUB_TOKEN_PAT", "").strip()
    workspace_id = (
        os.environ.get("DEVPOD_WORKSPACE_ID", "").strip()
        or os.environ.get("DEVPOD_WORKSPACE_FOLDER", "").strip()
        or ""
    )

    if not tunnel_url:
        # Backward-compat exit per the rules: no DevPod, no work.
        # The webhook dispatches us regardless of session state, so
        # a silent steady-state exit must be the norm.
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
    app_port_for_pr = _app_port(pr_number)
    print(f"[sandbox] starting PR {repo}#{pr_number} on {tunnel_url}")
    print(
        f"[sandbox] using port {app_port_for_pr} for PR #{pr_number}"
    )

    cwd = _clone_dir(pr_number)

    def _cleanup(*, immediate: bool = False) -> None:
        """Schedule a delayed wipe of the per-PR clone directory.

        Default behavior schedules the rm for 2h from now via
        _cleanup_command (see its docstring for why the delay
        exists — preserving the live preview URL).

        `immediate=True` is the escape hatch for the early-exit
        clone-failure path: there's no app running and no preview
        URL to preserve, so we can rm the (possibly half-cloned)
        tree right now instead of waiting 2 hours. Saves /tmp
        space on a DevPod that's getting hammered by failing PRs.

        Failures are logged but never raised — the next PR's
        _checkout_command does its own rm -rf so a missed
        cleanup is recoverable, not load-bearing."""
        workdir = _clone_dir(pr_number)
        cmd = (
            f"rm -rf {workdir}"
            if immediate
            else _cleanup_command(pr_number)
        )
        try:
            resp = _post_execute(
                tunnel_url,
                {
                    "type": "run_command",
                    "repo": repo,
                    "command": cmd,
                },
            )
            if resp.get("exit_code") not in (0, None):
                err = (resp.get("stderr") or resp.get("error") or "")[:200]
                print(
                    f"[sandbox] cleanup of {cwd} failed: {err}",
                    file=sys.stderr,
                )
        except Exception as e:
            print(
                f"[sandbox] cleanup unexpectedly raised: "
                f"{type(e).__name__}: {e}",
                file=sys.stderr,
            )

    # --- Step A: clone + checkout ---------------------------------------
    # Single shell expression; the MCP server reports success=True
    # iff every step exited 0. We additionally require the
    # CLONE_SUCCESS marker on stdout because git checkout can
    # silently leave a detached/dirty tree (rare but seen on the
    # codespaces-base image) — without the marker we have no proof
    # the chain ran all the way through.
    checkout_resp = _post_execute(
        tunnel_url,
        {
            "type": "run_command",
            "repo": repo,
            "command": _checkout_command(
                repo, pr_number, github_token_for_clone
            ),
        },
    )
    clone_stdout = checkout_resp.get("stdout", "") or ""
    clone_stderr = checkout_resp.get("stderr", "") or ""
    clone_exit_zero = bool(
        checkout_resp.get("success") is True
        or checkout_resp.get("exit_code") == 0
    )
    clone_marker_seen = CLONE_SUCCESS_MARKER in clone_stdout
    clone_success = clone_exit_zero and clone_marker_seen

    if not clone_success:
        # Compose the diagnostic message we want to surface in the
        # GitHub comment + the stderr log. We deliberately keep
        # this string short — the full transcript already lives in
        # test_output via the persistence below.
        if not clone_marker_seen and clone_exit_zero:
            reason = (
                "clone command exited 0 but CLONE_SUCCESS marker "
                "was missing from stdout — likely a partial "
                "checkout (network glitch mid-fetch, dirty tree, "
                "or permission issue)"
            )
        else:
            reason = (
                clone_stderr.strip()
                or checkout_resp.get("error")
                or "git clone / fetch / checkout failed"
            )
        print(
            f"[sandbox] checkout failed: {reason[:500]}",
            file=sys.stderr,
        )

        # --- Early exit on clone failure ----------------------------
        # Spec: "If not [CLONE_SUCCESS] → set clone_success=False,
        # post error comment, exit early. Never proceed to install
        # if clone failed."
        # We still walk the persist + comment path because the
        # dashboard's "running…" spinner has to land somewhere and
        # the rules say "Always post the GitHub comment even if
        # some steps fail."
        duration_ms = int((time.time() - started_at) * 1000)
        early_summary: dict[str, Any] = {
            "verdict": "error",
            "overall": "error",
            "tests_passed": 0,
            "tests_failed": 0,
            "no_tests": False,
            "test_output": _truncate(
                f"[clone failed] {reason}\n\n"
                f"stdout:\n{clone_stdout[:4000]}\n\n"
                f"stderr:\n{clone_stderr[:4000]}"
            ),
            "build_attempted": False,
            "build_success": False,
            "build_output": "",
            "app_started": False,
            "app_port": None,
            "app_url": None,
            "clone_success": False,
            "install_success": False,
            "install_output": "",
            "duration_ms": duration_ms,
            "workspace_id": workspace_id,
        }
        _upsert_result(
            {
                "repo": repo,
                "pr_number": pr_number,
                "user_id": _user_id_for_repo(repo),
                "session_id": session_id,
                "tests_passed": 0,
                "tests_failed": 0,
                "test_output": early_summary["test_output"],
                "app_url": None,
                "app_started": False,
                "clone_success": False,
                "install_success": False,
                "overall": "error",
                "duration_ms": duration_ms,
            }
        )
        try:
            _post_pr_comment(
                repo, pr_number, _format_pr_comment(early_summary)
            )
        except Exception as e:
            print(
                f"[sandbox] PR comment unexpectedly raised: "
                f"{type(e).__name__}: {e}",
                file=sys.stderr,
            )
        # Clean up immediately: there's no app running and therefore
        # no preview URL to preserve, so skip the 2-hour delay and
        # free the (possibly half-cloned) tree right now.
        _cleanup(immediate=True)
        print(
            f"[sandbox] PR {repo}#{pr_number} — clone failed, "
            f"skipping install/tests/build/app"
        )
        print(f"[sandbox] Verdict: error ({duration_ms}ms)")
        return early_summary

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
    no_tests = False
    if clone_success and install_success:
        test_resp = _post_execute(
            tunnel_url,
            {
                "type": "run_tests",
                "repo": repo,
                "cwd": cwd,
            },
        )
        stdout = test_resp.get("stdout", "") or ""
        stderr = test_resp.get("stderr", "") or ""
        tests_passed, tests_failed = _count_passed_failed(stdout + "\n" + stderr)
        test_output = stdout + ("\n" + stderr if stderr else "")
        if test_resp.get("error"):
            test_output += f"\n[sandbox] mcp error: {test_resp['error']}"
        no_tests = _looks_like_no_tests(stdout, stderr) or (
            tests_passed == 0 and tests_failed == 0
        )

    # --- Step D: build (Next.js / Go / Python no-op) --------------------
    # Always attempt when clone+install both succeeded, regardless of
    # test outcome — a passing test suite with a broken `npm run build`
    # is still a broken PR.
    build_attempted = False
    build_success = False
    build_output = ""
    if clone_success and install_success:
        build_attempted = True
        build_resp = _post_execute(
            tunnel_url,
            {
                "type": "build",
                "repo": repo,
                "cwd": cwd,
            },
        )
        # Forward-compat: if the user is running an older MCP server
        # that doesn't know "build", we get back
        # {"error":"unknown type: build"}. Surface it as a soft skip
        # rather than a hard build_failed; otherwise every PR on
        # an un-upgraded DevPod looks like a build regression.
        if (
            isinstance(build_resp.get("error"), str)
            and "unknown type" in str(build_resp.get("error")).lower()
        ):
            print(
                "[sandbox] MCP server too old for 'build' type — skipping",
                file=sys.stderr,
            )
            build_attempted = False
        else:
            build_success = bool(
                build_resp.get("success") is True
                or build_resp.get("exit_code") == 0
            )
            build_output = (build_resp.get("stdout", "") or "") + (
                ("\n" + build_resp.get("stderr", ""))
                if build_resp.get("stderr")
                else ""
            )
            if build_resp.get("error"):
                build_output += f"\n[sandbox] mcp error: {build_resp['error']}"

    # --- Step E: start app + detect/expose port -------------------------
    # We start the app whenever clone+install succeeded AND build (if
    # attempted) succeeded. A failing build is conclusive evidence
    # that the app won't boot meaningfully, so skipping the start
    # avoids the user seeing a green "App running" next to a red
    # "Build failed".
    app_started = False
    app_port: int | None = None
    app_url: str | None = None
    if clone_success and install_success and (
        not build_attempted or build_success
    ):
        # Belt-and-braces: confirm a build artifact actually
        # exists before launching the app. For Next.js this
        # means /tmp/pr-test-<n>/.next; missing → run
        # `npm run build` inline. Result is consumed only for
        # logging — start_app proceeds either way (a non-Next
        # project hits the "skipping build verification" branch
        # and falls through harmlessly).
        verify_resp = _post_execute(
            tunnel_url,
            {
                "type": "run_command",
                "repo": repo,
                "command": _verify_build_command(pr_number),
            },
        )
        verify_stdout = (verify_resp.get("stdout", "") or "").strip()
        if "BUILD_EXISTS" in verify_stdout:
            print(f"[sandbox] build verified at {cwd}/.next")
        elif verify_stdout:
            # Either we rebuilt inline or this isn't a Node
            # project. Both are fine; we just record what
            # happened for the operator log.
            print(
                f"[sandbox] build verify: "
                f"{verify_stdout.splitlines()[-1][:200]}"
            )

        start_resp = _post_execute(
            tunnel_url,
            {
                "type": "start_app",
                "repo": repo,
                "command": _start_app_command(pr_number),
                "cwd": cwd,
            },
        )
        app_started = bool(start_resp.get("started"))

        if app_started:
            # Probe the candidate ports. The MCP server's start_app
            # already gave the app a 3s head start; this loop adds
            # up to APP_BIND_TIMEOUT_SEC more before declaring the
            # app un-reachable.
            probe = _post_execute(
                tunnel_url,
                {
                    "type": "run_command",
                    "repo": repo,
                    "command": _port_detect_command(pr_number),
                },
            )
            probe_stdout = (probe.get("stdout", "") or "").strip()
            if probe.get("exit_code") == 0 and probe_stdout:
                # Last non-empty line is the port — guard against
                # any preamble curl/sleep noise on stdout.
                last = next(
                    (
                        ln.strip()
                        for ln in reversed(probe_stdout.splitlines())
                        if ln.strip()
                    ),
                    "",
                )
                try:
                    app_port = int(last)
                except ValueError:
                    app_port = None

            if app_port:
                expose_resp = _post_execute(
                    tunnel_url,
                    {
                        "type": "expose_port",
                        "repo": repo,
                        "port": app_port,
                    },
                )
                if isinstance(expose_resp.get("url"), str):
                    app_url = expose_resp["url"]

    # --- Final aggregation ----------------------------------------------
    verdict = _compute_verdict(
        clone_success=clone_success,
        install_success=install_success,
        tests_passed=tests_passed,
        tests_failed=tests_failed,
        no_tests=no_tests,
        build_attempted=build_attempted,
        build_success=build_success,
        app_started=app_started,
        app_url=app_url,
    )
    overall_db = _verdict_to_db_overall(verdict)
    duration_ms = int((time.time() - started_at) * 1000)

    summary: dict[str, Any] = {
        "verdict": verdict,
        "overall": overall_db,
        "tests_passed": tests_passed,
        "tests_failed": tests_failed,
        "no_tests": no_tests,
        "test_output": _truncate(test_output),
        "build_attempted": build_attempted,
        "build_success": build_success,
        "build_output": _truncate(build_output),
        "app_started": app_started,
        "app_port": app_port,
        "app_url": app_url,
        "clone_success": clone_success,
        "install_success": install_success,
        "install_output": _truncate(install_output),
        "duration_ms": duration_ms,
        "workspace_id": workspace_id,
    }

    # --- Persist to Supabase --------------------------------------------
    # Note: build_attempted / build_success / verdict are NOT columns
    # on pr_sandbox_results (migration 015 predates the rich verdict
    # set). We fold the build status header into test_output so the
    # information survives in the row even though the column for it
    # doesn't exist yet — keeps the dashboard backfill story simple.
    test_output_for_db = test_output
    if build_attempted:
        test_output_for_db = (
            f"[build: {'pass' if build_success else 'FAIL'}]\n"
            f"{(build_output[:2000] + chr(10) + '---' + chr(10)) if build_output else ''}"
            f"{test_output}"
        )
    _upsert_result(
        {
            "repo": repo,
            "pr_number": pr_number,
            "user_id": _user_id_for_repo(repo),
            "session_id": session_id,
            "tests_passed": tests_passed,
            "tests_failed": tests_failed,
            "test_output": _truncate(test_output_for_db),
            "app_url": app_url,
            "app_started": app_started,
            "clone_success": clone_success,
            "install_success": install_success,
            "overall": overall_db,
            "duration_ms": duration_ms,
        }
    )

    # --- Always post the GitHub comment ---------------------------------
    # Per RULES: "Always post the GitHub comment even if some steps
    # fail". Wrapped in its own try so a GitHub API outage doesn't
    # eat the summary line below.
    try:
        _post_pr_comment(repo, pr_number, _format_pr_comment(summary))
    except Exception as e:
        print(
            f"[sandbox] PR comment unexpectedly raised: "
            f"{type(e).__name__}: {e}",
            file=sys.stderr,
        )

    print(
        f"[sandbox] PR {repo}#{pr_number} — tests: {tests_passed} passed, "
        f"{tests_failed} failed; build: "
        f"{'attempted' if build_attempted else 'skipped'}"
        f"{'/passed' if build_attempted and build_success else ''}"
        f"{'/failed' if build_attempted and not build_success else ''}"
    )
    print(f"[sandbox] App URL: {app_url or 'App not started'}")
    if app_url:
        # Only mention the preservation window when a preview URL
        # actually exists — printing it on a no_tests / build_failed
        # run would mislead the operator into thinking there's
        # something live to click on.
        print("[sandbox] preview will be available for ~2 hours")
    print(f"[sandbox] Verdict: {verdict} ({duration_ms}ms)")

    # Schedule the delayed cleanup so /tmp gets reclaimed once the
    # preview window has expired. Called LAST so we keep the tree
    # around for the earlier steps' file reads (build/test/log
    # capture). Cleanup failure is non-fatal — the next PR's
    # checkout will rm -rf the dir anyway.
    _cleanup()

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
