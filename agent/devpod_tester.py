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
  1b. Detect the stack        — one probe round-trip lists the manifests /
                               lockfiles in the tree; the orchestrator
                               (NOT the MCP server) picks the package
                               manager + the install / test / build
                               commands. See _detect_command /
                               _stack_commands. Supported: Node (npm /
                               pnpm / yarn / bun), Python (requirements /
                               pyproject / pipfile), Go, Rust, Java
                               (maven / gradle), Ruby, PHP, .NET.
  2. Install dependencies     — the detected stack's install command,
                               with a 300s MCP timeout (cargo / maven /
                               dotnet restores can be slow). Best-effort.
  3. Run the test suite       — the detected stack's test command, sent
                               explicitly to the MCP server's run_tests
                               (300s). Exit-code-aware: a non-zero exit
                               flags as failing even when the heuristic
                               counter can't parse a count.
  4. Build                    — the detected stack's build command via the
                               MCP "build" handler (180s timeout). Python
                               uses `compileall` as a cheap syntax check.
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
  ANTHROPIC_API_KEY       enables Phase 4 generated tests (advisory) and
                          the auto-fix builder. Absent -> both skip.
  ALLOW_AUTO_FIX_PR       "false" (default) | "true". When true AND a
                          generated test reproduces a likely bug, opens a
                          fix PR against the contributor's branch + emails.
  LYNCAS_GEN_TESTS_MODEL  override for the test-gen model (Sonnet default).
  LYNCAS_AUTOFIX_MODEL    override for the fix model (Opus default).
  DISABLE_GENERATED_TESTS "true" kill-switch for generation.
  GMAIL_USER / GMAIL_APP_PASSWORD / DIGEST_RECIPIENT
                          optional — used only to email an opened auto-fix
                          PR; missing -> the email step soft-skips.
"""

from __future__ import annotations

import base64
import json
import os
import re
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

# --- Phase 4: Claude-generated tests --------------------------------------
# Generation runs ONLY here (the EC2 / webhook path): the DevPod has no
# Anthropic key (CLAUDE.md rule 5) and the Vercel route has no budget for a
# Claude call + a test run. Generated tests are advisory — they never affect
# the gate or the verdict — and live in a quarantined dir that is wiped with
# the rest of the clone tree, so they never touch the author's branch.
ANTHROPIC_API = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
# Sonnet is plenty for scaffolding deterministic unit tests and ~5x cheaper
# than Opus. Override with LYNCAS_GEN_TESTS_MODEL.
GEN_TESTS_MODEL = os.environ.get(
    "LYNCAS_GEN_TESTS_MODEL", "claude-sonnet-4-5"
)
# Quarantine directory (relative to the clone root) the generated tests are
# written into. Chosen to be obviously non-authored so nobody mistakes it
# for a real suite, and so a stray `git add .` would be a visible mistake.
GEN_TESTS_DIR = "__lyncas_generated_tests__"
# Bounds to keep token spend + round-trips predictable.
MAX_GEN_SOURCE_FILES = 5
MAX_GEN_FILE_BYTES = 6000
MAX_GEN_FILES_WRITTEN = 3
GEN_MAX_TOKENS = 4096

# --- Phase 4b: auto-fix builder -------------------------------------------
# When a generated test reproduces a likely bug, the builder asks Claude for
# a minimal fix and opens a PR *against the contributor's branch* (base =
# PR head ref) so merging it fixes the PR — never against the default branch.
# OFF by default (mirrors ALLOW_AUTO_CLOSE): opening PRs on someone's behalf
# is a high-trust action, so it's strictly opt-in via env.
ALLOW_AUTO_FIX_PR = os.environ.get(
    "ALLOW_AUTO_FIX_PR", "false"
).strip().lower() in ("1", "true", "yes")
# Opus is worth it for the actual code fix (vs Sonnet for test scaffolding).
AUTOFIX_MODEL = os.environ.get("LYNCAS_AUTOFIX_MODEL", "claude-opus-4-5")
AUTOFIX_MAX_TOKENS = 8000
AUTOFIX_BRANCH_PREFIX = "lyncas-autofix"


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


# --- Stack detection (Phase 2) -------------------------------------------
#
# Detection now lives in the orchestrator (here + the run-pr-tests route)
# instead of the MCP server. The MCP server is a dumb executor that runs
# whatever `command` we hand it (see mcp-server/route.ts). The flow is:
#
#   1. _detect_command(): a single shell probe that prints which manifests
#      / lockfiles exist in the clone tree plus the raw package.json (for
#      script parsing). One round-trip, no decisions made DevPod-side.
#   2. _parse_detect(): turn that stdout into a {flag: bool} dict + parsed
#      package.json scripts.
#   3. _stack_commands(): pick the language + package manager and return
#      the (label, install, test, build) command strings to run.
#
# Keep this matrix in lockstep with resolveStack() in
# dashboard/app/api/devpod/run-pr-tests/route.ts — the EC2 path and the
# chat-button path must detect identically or their verdicts drift.

DETECT_DONE_MARKER = "LYNCAS_DETECT_DONE"

# (flag key, filename) pairs probed by _detect_command. gradle + csproj
# are handled separately because they need an OR / glob test.
_DETECT_FILES = [
    ("pkg", "package.json"),
    ("pnpm_lock", "pnpm-lock.yaml"),
    ("yarn_lock", "yarn.lock"),
    ("bun_lock", "bun.lockb"),
    ("npm_lock", "package-lock.json"),
    ("requirements", "requirements.txt"),
    ("pyproject", "pyproject.toml"),
    ("setuppy", "setup.py"),
    ("pipfile", "Pipfile"),
    ("gomod", "go.mod"),
    ("cargo", "Cargo.toml"),
    ("gemfile", "Gemfile"),
    ("pom", "pom.xml"),
    ("composer", "composer.json"),
]


def _detect_command(pr_number: int) -> str:
    """Single shell probe that emits a compact descriptor of the clone
    tree on stdout. Each manifest/lockfile becomes a
    `LYNCAS_DETECT:<key>=0|1` line; package.json (if present) is dumped
    between LYNCAS_PKG_START/END markers so the orchestrator can parse
    its `scripts`. Always exits 0 so a missing tree reads as "nothing
    detected" rather than an error."""
    workdir = _clone_dir(pr_number)
    parts = [f"cd {workdir} 2>/dev/null || exit 0"]
    for key, fname in _DETECT_FILES:
        parts.append(
            f'( [ -f {fname} ] && echo "LYNCAS_DETECT:{key}=1" '
            f'|| echo "LYNCAS_DETECT:{key}=0" )'
        )
    parts.append(
        '( ( [ -f build.gradle ] || [ -f build.gradle.kts ] ) '
        '&& echo "LYNCAS_DETECT:gradle=1" '
        '|| echo "LYNCAS_DETECT:gradle=0" )'
    )
    parts.append(
        '( ls *.csproj >/dev/null 2>&1 '
        '&& echo "LYNCAS_DETECT:csproj=1" '
        '|| echo "LYNCAS_DETECT:csproj=0" )'
    )
    parts.append(
        '( [ -f package.json ] '
        '&& ( echo LYNCAS_PKG_START; head -c 8000 package.json; '
        'echo; echo LYNCAS_PKG_END ) || true )'
    )
    parts.append(f"echo {DETECT_DONE_MARKER}")
    return " ; ".join(parts)


def _parse_detect(stdout: str) -> dict[str, Any]:
    """Parse _detect_command output into a flag dict. `_scripts` holds
    the package.json scripts map (empty if absent / unparseable)."""
    flags: dict[str, Any] = {}
    pkg_lines: list[str] = []
    in_pkg = False
    for line in (stdout or "").splitlines():
        s = line.strip()
        if s == "LYNCAS_PKG_START":
            in_pkg = True
            continue
        if s == "LYNCAS_PKG_END":
            in_pkg = False
            continue
        if in_pkg:
            pkg_lines.append(line)
            continue
        if s.startswith("LYNCAS_DETECT:"):
            kv = s[len("LYNCAS_DETECT:"):]
            if "=" in kv:
                k, v = kv.split("=", 1)
                flags[k] = v.strip() == "1"
    scripts: dict[str, str] = {}
    if pkg_lines:
        try:
            pkg = json.loads("\n".join(pkg_lines))
            raw = pkg.get("scripts")
            if isinstance(raw, dict):
                scripts = {k: str(v) for k, v in raw.items()}
        except Exception:
            pass
    flags["_scripts"] = scripts
    return flags


def _node_pm(flags: dict[str, Any]) -> str:
    """Pick the JS package manager from the lockfile present, defaulting
    to npm. Lockfile beats any `packageManager` field guess."""
    if flags.get("pnpm_lock"):
        return "pnpm"
    if flags.get("yarn_lock"):
        return "yarn"
    if flags.get("bun_lock"):
        return "bun"
    return "npm"


def _stack_commands(
    pr_number: int, flags: dict[str, Any]
) -> tuple[str, str, str, str]:
    """Return (label, install_cmd, test_cmd, build_cmd) for the detected
    stack. Every command is self-contained (cd into the workdir, redirect
    stderr) so the caller can hand it straight to the MCP server.

    Language precedence when a repo mixes manifests: Node → Python → Go →
    Rust → Java → Ruby → PHP → .NET. The first match wins for the
    test/build runner; this mirrors resolveStack() in the TS route."""
    workdir = _clone_dir(pr_number)
    cd = f"cd {workdir} && "
    scripts = flags.get("_scripts", {}) or {}

    def has_script(name: str) -> bool:
        val = scripts.get(name, "")
        if name == "test":
            # npm's `init` placeholder isn't a real test command.
            return bool(val) and "no test specified" not in val
        return bool(val)

    # --- Node / JS / TS ---
    if flags.get("pkg"):
        pm = _node_pm(flags)
        if pm == "npm":
            install = "npm install --no-audit --no-fund 2>&1"
            run = "npm run"
            test_script = "npm test"
        elif pm == "pnpm":
            install = (
                "corepack pnpm install --frozen-lockfile 2>&1 "
                "|| pnpm install 2>&1"
            )
            run = "pnpm run"
            test_script = "pnpm test"
        elif pm == "yarn":
            install = (
                "yarn install --frozen-lockfile 2>&1 || yarn install 2>&1"
            )
            run = "yarn run"
            test_script = "yarn test"
        else:  # bun
            install = "bun install 2>&1"
            run = "bun run"
            test_script = "bun test"

        if has_script("test"):
            test = f"{test_script} 2>&1"
        else:
            # No test script — try the common runners' binaries via npx
            # without triggering a network install.
            test = (
                "npx --no-install vitest run 2>&1 "
                "|| npx --no-install jest 2>&1 "
                "|| npx --no-install mocha 2>&1 "
                '|| echo "no test runner detected"'
            )
        if has_script("build"):
            build = f"{run} build 2>&1"
        else:
            build = 'echo "no build script in package.json"'
        return f"Node ({pm})", cd + install, cd + test, cd + build

    # --- Python ---
    if (
        flags.get("requirements")
        or flags.get("pyproject")
        or flags.get("setuppy")
        or flags.get("pipfile")
    ):
        if flags.get("requirements"):
            install = "pip install -r requirements.txt 2>&1"
        elif flags.get("pyproject") or flags.get("setuppy"):
            install = "pip install -e . 2>&1 || pip install . 2>&1"
        else:  # pipfile
            install = "pip install pipenv 2>&1 && pipenv install --dev 2>&1"
        # pytest first; fall back to stdlib unittest discovery.
        test = (
            "python -m pytest -q 2>&1 "
            "|| python -m unittest discover -v 2>&1"
        )
        # No universal build step; compileall is a cheap syntax check
        # across the whole tree, which catches import-time SyntaxErrors
        # the way a real build would.
        build = "python -m compileall -q . 2>&1"
        return "Python", cd + install, cd + test, cd + build

    # --- Go ---
    if flags.get("gomod"):
        install = "go mod download 2>&1"
        # -v so individual --- PASS/FAIL lines print (the heuristic
        # counter keys on those); -race needs cgo so fall back without.
        test = (
            "go test ./... -v -race -cover 2>&1 "
            "|| go test ./... -v -cover 2>&1"
        )
        build = "go build ./... 2>&1"
        return "Go", cd + install, cd + test, cd + build

    # --- Rust ---
    if flags.get("cargo"):
        return (
            "Rust",
            cd + "cargo fetch 2>&1",
            cd + "cargo test 2>&1",
            cd + "cargo build 2>&1",
        )

    # --- Java / Kotlin ---
    if flags.get("pom"):
        return (
            "Java (maven)",
            cd + "mvn -q -DskipTests dependency:resolve 2>&1 || true",
            cd + "mvn -q test 2>&1",
            cd + "mvn -q -DskipTests package 2>&1",
        )
    if flags.get("gradle"):
        gw = "( [ -x ./gradlew ] && ./gradlew"
        return (
            "Java (gradle)",
            cd + f"{gw} dependencies 2>&1 ) || gradle dependencies 2>&1 || true",
            cd + f"{gw} test 2>&1 ) || gradle test 2>&1",
            cd + f"{gw} build -x test 2>&1 ) || gradle build -x test 2>&1",
        )

    # --- Ruby ---
    if flags.get("gemfile"):
        return (
            "Ruby",
            cd + "bundle install 2>&1",
            cd + "bundle exec rspec 2>&1 || bundle exec rake test 2>&1",
            cd + 'echo "Ruby project — no build step"',
        )

    # --- PHP ---
    if flags.get("composer"):
        return (
            "PHP",
            cd + "composer install 2>&1",
            cd
            + "( [ -x ./vendor/bin/phpunit ] && ./vendor/bin/phpunit 2>&1 ) "
            "|| composer test 2>&1",
            cd + 'echo "PHP project — no build step"',
        )

    # --- .NET ---
    if flags.get("csproj"):
        return (
            ".NET",
            cd + "dotnet restore 2>&1",
            cd + "dotnet test 2>&1",
            cd + "dotnet build 2>&1",
        )

    # --- Unknown ---
    return (
        "unknown",
        cd + 'echo "no deps detected"',
        cd + 'echo "no test runner detected"',
        cd + 'echo "no build needed"',
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
    """Heuristic test-counter spanning the runners in the Phase 2
    matrix. Best-effort: a "no tests detected" run reports 0/0 and is
    classified as no_tests upstream. Strategies are tried in order and
    the first that yields a non-zero count wins, so a noisy log doesn't
    double-count across formats.

    Recognized:
      * jest / pytest / cargo: "N passed", "M failed"
      * mocha:                 "N passing", "M failing"
      * go test -v:            per-test "--- PASS:" / "--- FAIL:" lines
      * rspec:                 "N examples, M failures"
      * dotnet:                "Passed: N", "Failed: M"
    """

    def first_int(pattern: str) -> int:
        m = re.search(pattern, stdout)
        return int(m.group(1)) if m else 0

    # 1. jest / pytest / cargo ("N passed; M failed").
    passed = first_int(r"(\d+)\s+passed")
    failed = first_int(r"(\d+)\s+failed")
    if passed or failed:
        return passed, failed

    # 2. mocha.
    passed = first_int(r"(\d+)\s+passing")
    failed = first_int(r"(\d+)\s+failing")
    if passed or failed:
        return passed, failed

    # 3. go test -v — count the per-test result lines directly.
    go_pass = len(re.findall(r"^--- PASS:", stdout, re.MULTILINE))
    go_fail = len(re.findall(r"^--- FAIL:", stdout, re.MULTILINE))
    if go_pass or go_fail:
        return go_pass, go_fail

    # 4. rspec.
    examples = first_int(r"(\d+)\s+examples?")
    failures = first_int(r"(\d+)\s+failures?")
    if examples or failures:
        return max(examples - failures, 0), failures

    # 5. dotnet ("Passed!  - Failed: 0, Passed: 5, ...").
    passed = first_int(r"Passed:\s*(\d+)")
    failed = first_int(r"Failed:\s*(\d+)")
    if passed or failed:
        return passed, failed

    return 0, 0


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


# --- Phase 3: quality checks ----------------------------------------------
#
# Diff-aware static analysis, security, and coverage that run LEFT of the
# preview gate. Every check is best-effort and tool-guarded: a missing
# tool reads as "skip", never "fail". Only the diff secret scan is
# blocking (configurable per repo); lint / type-check / audit / SAST /
# coverage are advisory. The structured results are persisted in
# pr_sandbox_results.checks (migration 022) and streamed to the chat card.
#
# Keep this mirrored with the equivalent logic in
# dashboard/app/api/devpod/run-pr-tests/route.ts.

CHECK_SKIP_MARKER = "LYNCAS_SKIP"

# High-confidence secret patterns scanned against ADDED diff lines only.
# Deliberately conservative — we'd rather miss a low-confidence match than
# block a good PR on a false positive. (label, compiled regex).
_SECRET_PATTERNS: list[tuple[str, Any]] = [
    ("AWS access key id", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("GitHub token", re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}")),
    ("Google API key", re.compile(r"AIza[0-9A-Za-z_\-]{35}")),
    ("Slack token", re.compile(r"xox[baprs]-[0-9A-Za-z-]{10,}")),
    ("Private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    (
        "Hardcoded credential",
        re.compile(
            r"(?i)(api[_-]?key|secret|password|passwd|token|access[_-]?key)"
            r"\s*[:=]\s*['\"][A-Za-z0-9_\-]{16,}['\"]"
        ),
    ),
]


def _fetch_pr_files(
    repo: str, pr_number: int, token: str
) -> list[dict[str, Any]]:
    """Fetch the PR's changed files (filename + patch) via the GitHub API.

    Used for diff awareness: the secret scan reads the added lines, and the
    `diff.changed_files` count + SAST scoping read the paths. Robust against
    the shallow clone (no git history needed). Returns [] on any failure —
    diff-dependent checks then degrade to "skip" rather than throwing."""
    if not token:
        return []
    status, data = _github_request(
        "GET",
        f"/repos/{repo}/pulls/{pr_number}/files?per_page=100",
        token,
    )
    if status != 200 or not isinstance(data, list):
        return []
    return [f for f in data if isinstance(f, dict)]


def _scan_secrets(files: list[dict[str, Any]]) -> dict[str, Any]:
    """Regex-scan the ADDED lines of the PR diff for secrets. Newly-added
    only (lines starting with '+'), so a pre-existing secret in the repo
    doesn't block every PR. Returns a check dict; status 'skip' when there
    were no files to scan (API miss)."""
    if not files:
        return {
            "status": "skip",
            "tool": "regex-diff",
            "count": 0,
            "findings": [],
        }
    findings: list[str] = []
    seen: set[str] = set()
    for f in files:
        patch = f.get("patch") or ""
        path = f.get("filename") or "?"
        for line in patch.splitlines():
            if not line.startswith("+") or line.startswith("+++"):
                continue
            content = line[1:]
            for label, rx in _SECRET_PATTERNS:
                if rx.search(content):
                    key = f"{path}: {label}"
                    if key not in seen:
                        seen.add(key)
                        findings.append(key)
                    break
    return {
        "status": "fail" if findings else "pass",
        "tool": "regex-diff",
        "count": len(findings),
        "findings": findings[:20],
    }


def _summarize_check(output: str, *, ok: bool) -> str:
    """Compress a check's raw output into a one-line summary for the comment
    / SSE. On success we say so; on failure we surface the last non-empty
    line (usually the error tally)."""
    if ok:
        return "passed"
    for line in reversed((output or "").splitlines()):
        s = line.strip()
        if s:
            return s[:200]
    return "failed"


def _lint_command(cd: str, flags: dict[str, Any]) -> tuple[str, str] | None:
    """(tool, command) for the detected stack's linter, or None to skip.
    Each command echoes CHECK_SKIP_MARKER when the tool isn't installed so
    the orchestrator can tell "no linter" from "lint failed"."""
    skip = f"echo {CHECK_SKIP_MARKER}"
    if flags.get("pkg"):
        return "eslint", cd + (
            "if npx --no-install eslint --version >/dev/null 2>&1; then "
            f"npx --no-install eslint . 2>&1; else {skip}; fi"
        )
    if flags.get("requirements") or flags.get("pyproject") or flags.get(
        "setuppy"
    ) or flags.get("pipfile"):
        return "ruff/flake8", cd + (
            "if command -v ruff >/dev/null 2>&1; then ruff check . 2>&1; "
            "elif command -v flake8 >/dev/null 2>&1; then flake8 2>&1; "
            f"else {skip}; fi"
        )
    if flags.get("gomod"):
        return "go vet", cd + "go vet ./... 2>&1"
    if flags.get("cargo"):
        return "clippy", cd + (
            "if cargo clippy --version >/dev/null 2>&1; then "
            f"cargo clippy 2>&1; else {skip}; fi"
        )
    return None


def _typecheck_command(
    cd: str, flags: dict[str, Any]
) -> tuple[str, str] | None:
    """(tool, command) for the detected stack's type-checker, or None."""
    skip = f"echo {CHECK_SKIP_MARKER}"
    if flags.get("pkg"):
        return "tsc", cd + (
            "if [ -f tsconfig.json ] && npx --no-install tsc --version "
            ">/dev/null 2>&1; then npx --no-install tsc --noEmit 2>&1; "
            f"else {skip}; fi"
        )
    if flags.get("requirements") or flags.get("pyproject") or flags.get(
        "setuppy"
    ) or flags.get("pipfile"):
        return "mypy/pyright", cd + (
            "if command -v mypy >/dev/null 2>&1; then mypy . 2>&1; "
            "elif command -v pyright >/dev/null 2>&1; then pyright 2>&1; "
            f"else {skip}; fi"
        )
    return None


def _audit_command(cd: str, flags: dict[str, Any]) -> tuple[str, str] | None:
    """(tool, command) for the detected stack's dependency-vulnerability
    audit, or None. Advisory — a non-zero exit means vulns were found, not
    that the PR is broken."""
    skip = f"echo {CHECK_SKIP_MARKER}"
    if flags.get("pkg"):
        return "npm audit", cd + (
            "if [ -f package-lock.json ]; then npm audit 2>&1; "
            f"else {skip}; fi"
        )
    if flags.get("requirements") or flags.get("pyproject") or flags.get(
        "setuppy"
    ) or flags.get("pipfile"):
        return "pip-audit", cd + (
            "if command -v pip-audit >/dev/null 2>&1; then pip-audit 2>&1; "
            f"else {skip}; fi"
        )
    if flags.get("gomod"):
        return "govulncheck", cd + (
            "if command -v govulncheck >/dev/null 2>&1; then "
            f"govulncheck ./... 2>&1; else {skip}; fi"
        )
    if flags.get("cargo"):
        return "cargo audit", cd + (
            "if command -v cargo-audit >/dev/null 2>&1; then "
            f"cargo audit 2>&1; else {skip}; fi"
        )
    return None


def _sast_command(
    cd: str, changed_files: list[str]
) -> tuple[str, str] | None:
    """(tool, command) for semgrep over the PR's changed files, or None when
    nothing changed. EC2-only (the heavy check, per the plan's watch-out).
    Skips itself when semgrep isn't installed."""
    paths = [p for p in changed_files if p]
    if not paths:
        return None
    # Quote each path; cap the count so a giant PR doesn't blow the arg list.
    quoted = " ".join(f"'{p}'" for p in paths[:200])
    skip = f"echo {CHECK_SKIP_MARKER}"
    return "semgrep", cd + (
        "if command -v semgrep >/dev/null 2>&1; then "
        f"semgrep --config auto --error {quoted} 2>&1; else {skip}; fi"
    )


def _parse_coverage(test_output: str) -> dict[str, Any]:
    """Opportunistically read a coverage percentage out of the test output
    we already captured — no extra command run. Recognizes pytest-cov's
    TOTAL line and Istanbul/jest's 'All files' row. Advisory; 'skip' when
    no coverage was reported."""
    if not test_output:
        return {"status": "skip", "pct": None, "tool": "n/a"}
    m = re.search(r"TOTAL\s+\d+\s+\d+\s+(\d+(?:\.\d+)?)%", test_output)
    if m:
        return {"status": "ok", "pct": float(m.group(1)), "tool": "pytest-cov"}
    m = re.search(r"All files\s*\|\s*([\d.]+)", test_output)
    if m:
        try:
            return {
                "status": "ok",
                "pct": float(m.group(1)),
                "tool": "istanbul",
            }
        except ValueError:
            pass
    return {"status": "skip", "pct": None, "tool": "n/a"}


# --- Phase 4: Claude-generated unit tests (advisory) ----------------------


def _anthropic_generate(
    system: str,
    user: str,
    *,
    model: str = GEN_TESTS_MODEL,
    max_tokens: int = GEN_MAX_TOKENS,
) -> str | None:
    """Call the Anthropic Messages API via urllib (keeps this module
    stdlib-only, like the GitHub calls). Returns the concatenated text
    blocks, or None on any failure / missing key."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        return None
    body = json.dumps(
        {
            "model": model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        ANTHROPIC_API,
        data=body,
        headers={
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            data = json.loads(r.read())
        blocks = data.get("content") or []
        texts = [
            b.get("text", "")
            for b in blocks
            if isinstance(b, dict) and b.get("type") == "text"
        ]
        joined = "\n".join(t for t in texts if t)
        return joined or None
    except Exception as e:
        print(
            f"[sandbox] gen-tests Anthropic call failed: "
            f"{type(e).__name__}: {e}",
            file=sys.stderr,
        )
        return None


def _gen_framework(flags: dict[str, Any]) -> str | None:
    """Which generation pathway applies to the detected stack. Only Node
    and Python are supported (the two most tractable to generate + run);
    everything else returns None → skipped."""
    if flags.get("pkg"):
        return "node"
    if (
        flags.get("requirements")
        or flags.get("pyproject")
        or flags.get("setuppy")
        or flags.get("pipfile")
    ):
        return "python"
    return None


def _select_source_files(
    changed_files: list[str], flags: dict[str, Any]
) -> list[str]:
    """Pick the PR's changed *source* files worth generating tests for —
    skips test files, type stubs, and vendored / build output. Capped to
    MAX_GEN_SOURCE_FILES to bound the prompt size."""
    node = bool(flags.get("pkg"))
    out: list[str] = []
    for f in changed_files:
        low = f.lower()
        base = low.rsplit("/", 1)[-1]
        if any(
            seg in low
            for seg in (
                "node_modules/",
                "dist/",
                "build/",
                ".next/",
                "vendor/",
                "migrations/",
            )
        ):
            continue
        if node:
            if not low.endswith(
                (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")
            ):
                continue
            if low.endswith(".d.ts"):
                continue
            if ".test." in base or ".spec." in base or "__tests__/" in low:
                continue
        else:
            if not low.endswith(".py"):
                continue
            if (
                base.startswith("test_")
                or base.endswith("_test.py")
                or low.startswith("tests/")
                or "/tests/" in low
            ):
                continue
        out.append(f)
        if len(out) >= MAX_GEN_SOURCE_FILES:
            break
    return out


def _read_remote_files(
    tunnel_url: str, repo: str, cwd: str, paths: list[str]
) -> dict[str, str]:
    """Cat the given paths from the clone tree on the DevPod, bounded per
    file. Returns {path: contents}. Used to give Claude the post-merge
    source as context for test generation."""
    if not paths:
        return {}
    parts = [f"cd {cwd} 2>/dev/null || exit 0"]
    for p in paths:
        parts.append(f"echo 'LYNCAS_FILE:{p}'")
        parts.append(f"head -c {MAX_GEN_FILE_BYTES} '{p}' 2>/dev/null")
        parts.append("echo ''")
        parts.append("echo 'LYNCAS_FILE_END'")
    resp = _post_execute(
        tunnel_url,
        {
            "type": "run_command",
            "repo": repo,
            "command": " ; ".join(parts),
            "timeout": 60,
        },
    )
    files: dict[str, str] = {}
    cur: str | None = None
    buf: list[str] = []
    for line in (resp.get("stdout", "") or "").splitlines():
        if line.startswith("LYNCAS_FILE:"):
            cur = line[len("LYNCAS_FILE:"):].strip()
            buf = []
        elif line.strip() == "LYNCAS_FILE_END":
            if cur is not None:
                files[cur] = "\n".join(buf).strip("\n")
            cur, buf = None, []
        elif cur is not None:
            buf.append(line)
    return files


def _build_gen_prompt(
    framework: str, js_runner: str, sources: dict[str, str]
) -> tuple[str, str]:
    """Compose (system, user) for the test-generation call. The user
    message carries the changed source files + framework-specific import
    guidance so the generated tests have the best chance of resolving."""
    system = (
        "You are a senior software engineer who writes focused, "
        "deterministic unit tests. You output ONLY a single JSON object "
        "and nothing else."
    )
    if framework == "node":
        if js_runner == "vitest":
            runner_note = (
                "Use Vitest. Import helpers explicitly: "
                "`import { describe, it, expect } from 'vitest';`."
            )
        else:
            runner_note = (
                "Use Jest. Rely on the injected globals "
                "(describe / it / expect) — do NOT import the test runner."
            )
        import_note = (
            "The test files will be saved under "
            f"`{GEN_TESTS_DIR}/` at the repository root. Import the code "
            "under test with a RELATIVE path from that directory and omit "
            "the file extension — e.g. for source `src/util/math.ts` use "
            "`import { add } from '../src/util/math';`."
        )
        lang_note = runner_note + " " + import_note
    else:
        lang_note = (
            "Use pytest: plain functions named `test_*` using `assert`. "
            "The test files will be saved under "
            f"`{GEN_TESTS_DIR}/` at the repository root, and pytest runs "
            "from the repo root — import source modules by their module "
            "path from the root, e.g. for `pkg/foo.py` use "
            "`from pkg.foo import thing`. If an import is ambiguous, write "
            "the most plausible one anyway — an import error is itself "
            "useful signal about an API break."
        )

    blocks = []
    for path, content in sources.items():
        blocks.append(f"=== FILE: {path} ===\n{content}")
    files_blob = "\n\n".join(blocks)

    user = (
        "Write unit tests for the functions / exports that changed in this "
        "PR, based on the source files below.\n\n"
        f"Framework & imports: {lang_note}\n\n"
        "Hard rules:\n"
        "- Tests MUST be deterministic: no network, no real database, no "
        "filesystem writes, no reliance on wall-clock time or unseeded "
        "randomness.\n"
        "- Only test behavior you can infer from the code shown; do not "
        "invent APIs that aren't present.\n"
        "- Prefer a few high-value tests over many shallow ones.\n\n"
        "Respond with ONLY this JSON shape (no prose, no code fences):\n"
        '{"tests": [{"path": "test_generated_<name>.<ext>", '
        '"content": "<full file contents>"}]}\n'
        f"At most {MAX_GEN_FILES_WRITTEN} files.\n\n"
        f"Changed source files:\n\n{files_blob}"
    )
    return system, user


def _safe_gen_path(p: Any) -> str | None:
    """Sanitize a model-supplied test path so it can't escape the
    quarantine dir. Allows a relative path of safe characters only."""
    if not isinstance(p, str):
        return None
    p = p.strip().lstrip("/")
    if not p or ".." in p.split("/"):
        return None
    if not re.match(r"^[A-Za-z0-9_][A-Za-z0-9_./-]*$", p):
        return None
    return p


def _parse_gen_response(text: str) -> list[tuple[str, str]]:
    """Pull the {"tests":[...]} payload out of Claude's response. Tolerant
    of stray prose / code fences: we slice from the first '{' to the last
    '}' and json.loads that."""
    if not text:
        return []
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1 or end < start:
        return []
    try:
        obj = json.loads(text[start : end + 1])
    except Exception:
        return []
    tests = obj.get("tests") if isinstance(obj, dict) else None
    if not isinstance(tests, list):
        return []
    out: list[tuple[str, str]] = []
    for item in tests:
        if not isinstance(item, dict):
            continue
        path = _safe_gen_path(item.get("path"))
        content = item.get("content")
        if path and isinstance(content, str) and content.strip():
            out.append((path, content))
        if len(out) >= MAX_GEN_FILES_WRITTEN:
            break
    return out


def _write_generated_tests(
    tunnel_url: str, repo: str, cwd: str, files: list[tuple[str, str]]
) -> int:
    """Write the generated test files into the quarantine dir via base64
    (avoids all shell-quoting pitfalls in the file content). Returns the
    number of files written, or 0 on failure."""
    parts = [f"mkdir -p '{cwd}/{GEN_TESTS_DIR}'"]
    count = 0
    for path, content in files:
        full = f"{cwd}/{GEN_TESTS_DIR}/{path}"
        parent = full.rsplit("/", 1)[0]
        b64 = base64.b64encode(content.encode("utf-8")).decode("ascii")
        parts.append(f"mkdir -p '{parent}'")
        parts.append(f"echo '{b64}' | base64 -d > '{full}'")
        count += 1
    parts.append("echo GEN_WRITE_DONE")
    resp = _post_execute(
        tunnel_url,
        {
            "type": "run_command",
            "repo": repo,
            "command": " && ".join(parts),
            "timeout": 60,
        },
    )
    ok = bool(resp.get("success") is True or resp.get("exit_code") == 0)
    if ok and "GEN_WRITE_DONE" in (resp.get("stdout", "") or ""):
        return count
    return 0


def _run_generated_tests(
    tunnel_url: str, repo: str, cwd: str, framework: str, js_runner: str
) -> dict[str, Any]:
    """Run the quarantined generated tests and return the raw MCP response.
    Node tries the detected runner first, then the other (both are common);
    Python uses pytest scoped to the quarantine dir."""
    d = GEN_TESTS_DIR
    if framework == "node":
        if js_runner == "vitest":
            cmd = (
                f"cd {cwd} && ( npx --no-install vitest run {d} 2>&1 "
                f"|| npx --no-install jest {d} 2>&1 )"
            )
        else:
            cmd = (
                f"cd {cwd} && ( npx --no-install jest {d} 2>&1 "
                f"|| npx --no-install vitest run {d} 2>&1 )"
            )
    else:
        cmd = f"cd {cwd} && python -m pytest {d} -q 2>&1"
    return _post_execute(
        tunnel_url,
        {
            "type": "run_command",
            "repo": repo,
            "command": cmd,
            "timeout": 300,
        },
    )


def _generate_tests_check(
    tunnel_url: str,
    repo: str,
    cwd: str,
    flags: dict[str, Any],
    changed_files: list[str],
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Generate, write, and run advisory unit tests for the PR's diff.

    Returns `(check_dict, artifacts)`. The check dict's status is 'skip'
    for every non-fatal off-ramp (no key, unsupported stack, nothing
    changed, generation/write failed). 'fail' (advisory) means a generated
    test failed or wouldn't import — `bug_candidate` flags those as seeds
    for the auto-fix builder. Never blocks the gate or the verdict.

    `artifacts` is non-None only when a failing (bug-candidate) run gives
    the auto-fix builder what it needs: the source contents, the generated
    test files, and the failure output."""

    def skip(
        summary: str, framework: str = "n/a"
    ) -> tuple[dict[str, Any], None]:
        return (
            {
                "status": "skip",
                "framework": framework,
                "written": 0,
                "passed": 0,
                "failed": 0,
                "summary": summary,
                "bug_candidate": False,
            },
            None,
        )

    if os.environ.get("DISABLE_GENERATED_TESTS", "").strip().lower() in (
        "1",
        "true",
        "yes",
    ):
        return skip("disabled")
    if not os.environ.get("ANTHROPIC_API_KEY", "").strip():
        return skip("no Anthropic key")
    framework = _gen_framework(flags)
    if framework is None:
        return skip("unsupported stack")
    sources = _select_source_files(changed_files, flags)
    if not sources:
        return skip("no changed source files", framework)

    to_read = list(sources)
    if framework == "node":
        to_read.append("package.json")
    contents = _read_remote_files(tunnel_url, repo, cwd, to_read)
    src_contents = {p: c for p, c in contents.items() if p in sources and c}
    if not src_contents:
        return skip("could not read changed files", framework)

    js_runner = "jest"
    if framework == "node":
        pkg = contents.get("package.json", "") or ""
        if '"vitest"' in pkg:
            js_runner = "vitest"
        elif '"jest"' in pkg:
            js_runner = "jest"
    fw_label = js_runner if framework == "node" else "pytest"

    system, user = _build_gen_prompt(framework, js_runner, src_contents)
    text = _anthropic_generate(system, user)
    if not text:
        return skip("generation returned nothing", fw_label)
    files = _parse_gen_response(text)
    if not files:
        return skip("no valid tests generated", fw_label)
    written = _write_generated_tests(tunnel_url, repo, cwd, files)
    if written <= 0:
        return skip("failed to write generated tests", fw_label)

    resp = _run_generated_tests(tunnel_url, repo, cwd, framework, js_runner)
    out = (resp.get("stdout", "") or "") + "\n" + (resp.get("stderr", "") or "")
    passed, failed = _count_passed_failed(out)
    exit0 = bool(resp.get("success") is True or resp.get("exit_code") == 0)
    low = out.lower()
    import_err = any(
        s in low
        for s in (
            "cannot find module",
            "modulenotfounderror",
            "no module named",
            "importerror",
            "syntaxerror",
            "cannot resolve",
        )
    )

    base = {"framework": fw_label, "written": written}
    artifacts = {
        "framework": framework,
        "js_runner": js_runner,
        "sources": src_contents,
        "tests": files,
        "output": out[-6000:],
    }
    if import_err:
        return (
            {
                **base,
                "status": "fail",
                "passed": passed,
                "failed": failed,
                "summary": (
                    "generated tests failed to import/compile "
                    "(possible API break or unresolved imports)"
                ),
                "bug_candidate": True,
            },
            artifacts,
        )
    if failed > 0:
        return (
            {
                **base,
                "status": "fail",
                "passed": passed,
                "failed": failed,
                "summary": (
                    f"{failed} generated test(s) failed — "
                    "possible bug or flaky test"
                ),
                "bug_candidate": True,
            },
            artifacts,
        )
    if passed > 0 and exit0:
        return (
            {
                **base,
                "status": "pass",
                "passed": passed,
                "failed": failed,
                "summary": f"{passed} generated test(s) passed",
                "bug_candidate": False,
            },
            None,
        )
    return (
        {
            **base,
            "status": "skip",
            "passed": passed,
            "failed": failed,
            "summary": "no runnable generated tests",
            "bug_candidate": False,
        },
        None,
    )


# --- Phase 4b: auto-fix builder (find bug -> propose fix -> open PR) -------


def _gh_get_pr_meta(
    repo: str, pr_number: int, token: str
) -> dict[str, Any] | None:
    """Fetch the PR's head ref/sha + head repo so the builder can (a) verify
    the PR is open and same-repo (we can't push a branch to a fork we don't
    own) and (b) base the fix branch on the contributor's head."""
    status, data = _github_request(
        "GET", f"/repos/{repo}/pulls/{pr_number}", token
    )
    if status != 200 or not isinstance(data, dict):
        return None
    head = data.get("head") or {}
    head_repo = (head.get("repo") or {}).get("full_name")
    return {
        "state": data.get("state"),
        "merged": bool(data.get("merged")),
        "head_ref": head.get("ref"),
        "head_sha": head.get("sha"),
        "head_repo": head_repo,
    }


def _gh_create_branch(
    repo: str, branch: str, sha: str, token: str
) -> bool:
    status, _ = _github_request(
        "POST",
        f"/repos/{repo}/git/refs",
        token,
        {"ref": f"refs/heads/{branch}", "sha": sha},
    )
    return status in (200, 201)


def _gh_get_file_sha(
    repo: str, path: str, ref: str, token: str
) -> str | None:
    q = urllib.parse.quote(path, safe="/")
    status, data = _github_request(
        "GET",
        f"/repos/{repo}/contents/{q}?ref={urllib.parse.quote(ref)}",
        token,
    )
    if status == 200 and isinstance(data, dict):
        sha = data.get("sha")
        return sha if isinstance(sha, str) else None
    return None


def _gh_put_file(
    repo: str,
    path: str,
    branch: str,
    message: str,
    content: str,
    sha: str | None,
    token: str,
) -> bool:
    body: dict[str, Any] = {
        "message": message,
        "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
        "branch": branch,
    }
    if sha:
        body["sha"] = sha
    q = urllib.parse.quote(path, safe="/")
    status, _ = _github_request(
        "PUT", f"/repos/{repo}/contents/{q}", token, body
    )
    return status in (200, 201)


def _gh_open_pr(
    repo: str, head: str, base: str, title: str, body: str, token: str
) -> dict[str, Any] | None:
    status, data = _github_request(
        "POST",
        f"/repos/{repo}/pulls",
        token,
        {"head": head, "base": base, "title": title, "body": body},
    )
    if status in (200, 201) and isinstance(data, dict):
        return data
    return None


def _build_fix_prompt(
    artifacts: dict[str, Any],
) -> tuple[str, str]:
    """Compose (system, user) for the auto-fix call. We hand Claude the
    changed source, the generated test(s) that failed, and the failure
    output, and ask it to first JUDGE whether this is a real bug before
    proposing a minimal fix."""
    system = (
        "You are a meticulous senior engineer triaging an automated test "
        "failure. A test was auto-generated against a PR's diff and it "
        "failed. Your job is FIRST to judge whether the failure reflects a "
        "REAL bug in the source (not a wrong or flaky generated test), and "
        "ONLY THEN to propose a minimal fix. Be conservative: if the "
        "generated test is incorrect or you're unsure, say so and propose "
        "no fix. You output ONLY a single JSON object."
    )

    src_blocks = []
    for path, content in (artifacts.get("sources") or {}).items():
        src_blocks.append(f"=== SOURCE FILE: {path} ===\n{content}")
    test_blocks = []
    for path, content in artifacts.get("tests") or []:
        test_blocks.append(f"=== GENERATED TEST: {path} ===\n{content}")
    output = artifacts.get("output") or ""

    user = (
        "A generated unit test failed against this PR. Decide if it reveals "
        "a real bug, and if so propose the smallest fix.\n\n"
        "Rules:\n"
        "- Only modify the SOURCE files shown below; never edit the tests.\n"
        "- Return FULL new contents for each source file you change.\n"
        "- Keep the change minimal and behavior-preserving except for the "
        "bug.\n"
        "- If the generated test is wrong / flaky / unsure, set "
        '"is_real_bug" false and return an empty "fixes" array.\n\n'
        "Respond with ONLY this JSON (no prose, no code fences):\n"
        '{"is_real_bug": true|false, "confidence": "high|medium|low", '
        '"explanation": "<one short paragraph>", '
        '"fixes": [{"path": "<source path>", "content": "<full file>"}]}\n\n'
        "Changed source files:\n\n"
        + "\n\n".join(src_blocks)
        + "\n\nGenerated test(s):\n\n"
        + "\n\n".join(test_blocks)
        + "\n\nTest failure output:\n\n"
        + output
    )
    return system, user


def _parse_fix_response(
    text: str, allowed_paths: set[str]
) -> dict[str, Any] | None:
    """Pull the fix JSON out of Claude's response and validate it. Returns
    None unless it's a confidently-real bug with at least one fix that only
    touches files we showed (so the model can't write arbitrary paths)."""
    if not text:
        return None
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        obj = json.loads(text[start : end + 1])
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    if not obj.get("is_real_bug"):
        return None
    if str(obj.get("confidence", "")).lower() == "low":
        return None
    raw_fixes = obj.get("fixes")
    if not isinstance(raw_fixes, list) or not raw_fixes:
        return None
    fixes: list[tuple[str, str]] = []
    for item in raw_fixes:
        if not isinstance(item, dict):
            continue
        path = item.get("path")
        content = item.get("content")
        if (
            isinstance(path, str)
            and path in allowed_paths
            and isinstance(content, str)
            and content.strip()
        ):
            fixes.append((path, content))
    if not fixes:
        return None
    return {
        "confidence": str(obj.get("confidence", "")).lower(),
        "explanation": str(obj.get("explanation", "")).strip(),
        "fixes": fixes,
    }


def _send_autofix_email(
    repo: str, pr_number: int, pr_url: str, explanation: str
) -> bool:
    """Best-effort notification that an auto-fix PR was opened. Soft-fails
    (logs + returns False) if the Gmail env vars aren't configured — we
    never want a mail hiccup to fail the sandbox run."""
    import smtplib
    from email.message import EmailMessage

    user = os.environ.get("GMAIL_USER", "").strip()
    password = os.environ.get("GMAIL_APP_PASSWORD", "").strip()
    if not user or not password:
        print("[sandbox] auto-fix: Gmail not configured — skipping email")
        return False
    recipient = os.environ.get("DIGEST_RECIPIENT", "").strip() or user
    try:
        msg = EmailMessage()
        msg["From"] = user
        msg["To"] = recipient
        msg["Subject"] = f"[Lyncas] Auto-fix PR opened for {repo}#{pr_number}"
        msg.set_content(
            f"Lyncas detected a likely bug in {repo}#{pr_number} via a "
            f"generated test and opened a fix PR:\n\n{pr_url}\n\n"
            f"Why:\n{explanation}\n\n"
            "This was auto-generated — review before merging."
        )
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as s:
            s.login(user, password)
            s.send_message(msg)
        return True
    except Exception as e:
        print(
            f"[sandbox] auto-fix email failed: {type(e).__name__}: {e}",
            file=sys.stderr,
        )
        return False


def _autofix_pr(
    repo: str,
    pr_number: int,
    token: str,
    artifacts: dict[str, Any],
) -> dict[str, Any]:
    """Builder bit (Improvements.md #5): a generated test reproduced a
    likely bug → ask Claude to judge + fix it → open a PR against the
    contributor's branch → email. Opt-in (ALLOW_AUTO_FIX_PR) and full of
    off-ramps; every failure degrades to a 'skip'/'error' status and never
    raises into the sandbox run."""

    def done(status: str, summary: str, **extra: Any) -> dict[str, Any]:
        return {"status": status, "summary": summary, **extra}

    if not ALLOW_AUTO_FIX_PR:
        return done("skip", "auto-fix disabled (ALLOW_AUTO_FIX_PR)")
    if not token:
        return done("skip", "no GitHub token")

    meta = _gh_get_pr_meta(repo, pr_number, token)
    if not meta:
        return done("skip", "could not load PR metadata")
    if meta.get("state") != "open" or meta.get("merged"):
        return done("skip", "PR not open")
    if meta.get("head_repo") != repo:
        # Fork PR: we can't push a branch to the fork, so there's nowhere to
        # open the fix from. (A future version could fork+PR, but that's out
        # of scope.)
        return done("skip", "fork PR — cannot push fix branch")
    head_ref = meta.get("head_ref")
    head_sha = meta.get("head_sha")
    if not head_ref or not head_sha:
        return done("skip", "missing PR head ref/sha")
    if str(head_ref).startswith(f"{AUTOFIX_BRANCH_PREFIX}/"):
        # Don't open an auto-fix for an auto-fix PR — that would loop.
        return done("skip", "PR is itself an auto-fix branch")

    system, user = _build_fix_prompt(artifacts)
    text = _anthropic_generate(
        system, user, model=AUTOFIX_MODEL, max_tokens=AUTOFIX_MAX_TOKENS
    )
    if not text:
        return done("skip", "fix generation returned nothing")
    allowed = set((artifacts.get("sources") or {}).keys())
    fix = _parse_fix_response(text, allowed)
    if not fix:
        return done("skip", "model judged not a real bug / no valid fix")

    branch = f"{AUTOFIX_BRANCH_PREFIX}/{pr_number}-{int(time.time())}"
    if not _gh_create_branch(repo, branch, head_sha, token):
        return done("error", "failed to create fix branch")

    commit_msg = f"fix: address bug in PR #{pr_number} found by Lyncas"
    written = 0
    for path, content in fix["fixes"]:
        file_sha = _gh_get_file_sha(repo, path, branch, token)
        if _gh_put_file(repo, path, branch, commit_msg, content, file_sha, token):
            written += 1
        else:
            print(
                f"[sandbox] auto-fix: failed to write {path}",
                file=sys.stderr,
            )
    if written == 0:
        return done("error", "failed to commit any fix files")

    files_list = "\n".join(f"- `{p}`" for p, _ in fix["fixes"])
    pr_body = (
        "## 🤖 Lyncas auto-fix\n\n"
        f"A generated test against #{pr_number} reproduced a likely bug. "
        "This PR proposes a minimal fix.\n\n"
        f"**Confidence:** {fix['confidence']}\n\n"
        f"**Why:** {fix['explanation']}\n\n"
        f"**Files changed:**\n{files_list}\n\n"
        "> Auto-generated by Lyncas — review before merging. Merge this into "
        f"the PR branch (`{head_ref}`) to apply the fix."
    )
    pr_title = f"Lyncas auto-fix for #{pr_number}"
    opened = _gh_open_pr(repo, branch, head_ref, pr_title, pr_body, token)
    if not opened:
        return done(
            "error", "failed to open fix PR", branch=branch
        )

    fix_pr_url = opened.get("html_url")
    fix_pr_number = opened.get("number")
    print(f"[sandbox] auto-fix: opened PR {fix_pr_url}")
    emailed = _send_autofix_email(
        repo, pr_number, fix_pr_url or "", fix["explanation"]
    )
    return done(
        "opened",
        f"opened fix PR #{fix_pr_number} ({fix['confidence']} confidence)",
        pr_url=fix_pr_url,
        pr_number=fix_pr_number,
        confidence=fix["confidence"],
        emailed=emailed,
    )


def _run_check(
    tunnel_url: str,
    repo: str,
    builder: tuple[str, str] | None,
    *,
    timeout: int = 180,
) -> dict[str, Any]:
    """Run one quality check on the DevPod and classify the result.

    `builder` is the (tool, command) pair from a *_command helper, or None
    when the check doesn't apply to the stack → 'skip'. The command echoes
    CHECK_SKIP_MARKER when its tool is missing → also 'skip'. Otherwise the
    exit code decides pass/fail. Network/MCP errors degrade to 'skip' so an
    advisory check can never sink the run."""
    if builder is None:
        return {"status": "skip", "tool": "n/a", "summary": "not applicable"}
    tool, cmd = builder
    resp = _post_execute(
        tunnel_url,
        {
            "type": "run_command",
            "repo": repo,
            "command": cmd,
            "timeout": timeout,
        },
    )
    stdout = resp.get("stdout", "") or ""
    stderr = resp.get("stderr", "") or ""
    if resp.get("error"):
        return {
            "status": "skip",
            "tool": tool,
            "summary": f"could not run: {resp['error']}"[:200],
        }
    if CHECK_SKIP_MARKER in stdout:
        return {"status": "skip", "tool": tool, "summary": "tool not available"}
    ok = bool(resp.get("success") is True or resp.get("exit_code") == 0)
    return {
        "status": "pass" if ok else "fail",
        "tool": tool,
        "summary": _summarize_check(stdout + "\n" + stderr, ok=ok),
    }


def _compute_verdict(
    *,
    clone_success: bool,
    install_success: bool,
    tests_passed: int,
    tests_failed: int,
    tests_ok: bool,
    no_tests: bool,
    build_attempted: bool,
    build_success: bool,
    secrets_blocking_failed: bool,
    app_started: bool,
    app_url: str | None,
) -> str:
    """Map the per-step outcomes to one of the six rich verdicts
    documented in the spec. The order of conditions matters: a
    failed build is more PR-relevant than failed tests (because a
    build failure blocks merge regardless), so we surface
    'build_failed' even if tests also failed.

    `tests_ok` is the exit-code-aware test signal (Phase 2): it's False
    whenever the test command exited non-zero even if the heuristic
    counter couldn't extract a failure count, so a runner we can't parse
    still flags as tests_failed instead of silently passing."""
    if not clone_success or not install_success:
        return "error"
    if build_attempted and not build_success:
        return "build_failed"
    # A newly-added secret in the diff is high-severity and blocking (when
    # the repo opts in) — surface it ahead of the test outcome.
    if secrets_blocking_failed:
        return "security_failed"
    if not no_tests and not tests_ok:
        return "tests_failed"
    if no_tests:
        return "no_tests"
    # Everything green up through build + tests; differentiate
    # pass with vs without a live preview URL.
    if app_started and app_url:
        return "pass"
    return "pass_no_preview"


def _compute_gate(
    *,
    clone_success: bool,
    install_success: bool,
    build_attempted: bool,
    build_success: bool,
    tests_failed: int,
    tests_ok: bool,
    no_tests: bool,
    secrets_blocking_failed: bool,
    secrets_count: int,
    block_on_test_failure: bool,
    require_tests_for_preview: bool,
) -> tuple[bool, str]:
    """Phase 1 preview gate. Decide whether the live preview (start_app +
    expose_port) is allowed to run. Returns (gate_passed, gate_reason);
    gate_reason is "" when the gate passes.

    Blocking conditions, in priority order:
      1. clone / install failed — nothing meaningful to preview.
      2. build attempted and failed — the app won't boot.
      3. authored tests failed (when block_on_test_failure) — a preview
         would imply "this works" when it demonstrably doesn't.
      4. no tests at all (only when require_tests_for_preview) — strict
         repos that mandate coverage before a preview goes out.

    Lint / type-check / security / generated-test signals are NOT part of
    this gate yet; those arrive in later phases of SANDBOX_TESTING_PLAN.md."""
    if not clone_success or not install_success:
        return False, "clone or install failed"
    if build_attempted and not build_success:
        return False, "build failed"
    if secrets_blocking_failed:
        plural = "secret" if secrets_count == 1 else "secrets"
        n = secrets_count or "a"
        return False, f"{n} {plural} detected in the diff"
    if block_on_test_failure and not no_tests and not tests_ok:
        if tests_failed > 0:
            plural = "test" if tests_failed == 1 else "tests"
            return False, f"{tests_failed} {plural} failed"
        return False, "tests failed"
    if require_tests_for_preview and no_tests:
        return False, "no tests found and this repo requires tests for a preview"
    return True, ""


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
    # Phase 3 columns (migration 022) that older databases won't have. If
    # the upsert fails because of them, we strip and retry so the core row
    # still lands on a pre-022 schema (soft-fail-on-DB-error contract).
    optional_keys = ("checks", "gate_passed", "gate_reason")

    def _attempt(payload: dict[str, Any]) -> None:
        body = json.dumps([payload]).encode("utf-8")
        req = urllib.request.Request(
            endpoint, data=body, headers=headers, method="POST"
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            r.read()

    try:
        _attempt(row)
    except Exception as e:
        if any(k in row for k in optional_keys):
            print(
                f"[sandbox] persist with Phase 3 columns failed "
                f"({type(e).__name__}: {e}); retrying without them — "
                "apply migration 022 to persist checks/gate_passed",
                file=sys.stderr,
            )
            stripped = {k: v for k, v in row.items() if k not in optional_keys}
            try:
                _attempt(stripped)
                return
            except Exception as e2:
                e = e2
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


def _repo_gate_config(repo: str) -> tuple[bool, bool, bool]:
    """Return the sandbox preview-gate config for `repo` as
    (block_on_test_failure, require_tests_for_preview, block_on_secrets).

    Reads repo_rules via PostgREST. Migration-tolerant: selects `*` and
    reads each key with a fallback, so the gate keeps working with its
    documented defaults (block_test=True, require=False, block_secrets=True)
    even before migrations 021/022 are applied or for repos with no rules
    row at all."""
    block_default, require_default, secrets_default = True, False, True
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        return block_default, require_default, secrets_default
    endpoint = (
        url.rstrip("/")
        + f"/rest/v1/repo_rules?repo=eq.{urllib.parse.quote(repo)}"
        "&select=*&limit=1"
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
                row = data[0]
                block = row.get("sandbox_block_on_test_failure")
                require = row.get("sandbox_require_tests_for_preview")
                secrets = row.get("sandbox_block_on_secrets")
                return (
                    block_default if block is None else bool(block),
                    require_default if require is None else bool(require),
                    secrets_default if secrets is None else bool(secrets),
                )
    except Exception as e:
        print(
            f"[sandbox] gate config lookup failed: {type(e).__name__}: {e}",
            file=sys.stderr,
        )
    return block_default, require_default, secrets_default


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
        "security_failed": "❌ Sandbox FAILED — secret detected in diff",
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


def _render_checks_section(checks: dict[str, Any]) -> list[str]:
    """Render the Phase 3 quality-check rows for the PR comment. Returns []
    when no checks ran (pre-clone failure / no install) so the comment stays
    clean. Advisory failures render ⚠️; the blocking secret scan renders ❌."""
    if not checks:
        return []

    def advisory_icon(status: str) -> str:
        return {"pass": "✅", "fail": "⚠️", "skip": "⏭"}.get(status, "—")

    rows: list[str] = []

    def add(label: str, result: dict[str, Any] | None) -> None:
        if not result:
            return
        status = result.get("status", "skip")
        tool = result.get("tool", "")
        suffix = f" ({tool})" if tool and tool != "n/a" else ""
        detail = (
            "passed"
            if status == "pass"
            else "skipped"
            if status == "skip"
            else (result.get("summary") or "issues found")
        )
        rows.append(
            f"| {label}{suffix} | {advisory_icon(status)} {detail} |"
        )

    add("Lint", checks.get("lint"))
    add("Type-check", checks.get("typecheck"))

    sec = checks.get("security") or {}
    add("Dependency audit", sec.get("audit"))
    add("SAST", sec.get("sast"))

    secrets = sec.get("secrets") or {}
    if secrets:
        s_status = secrets.get("status", "skip")
        s_count = secrets.get("count", 0)
        if s_status == "fail":
            icon, detail = "❌", f"{s_count} found in diff"
        elif s_status == "skip":
            icon, detail = "⏭", "skipped"
        else:
            icon, detail = "✅", "none in diff"
        rows.append(f"| Secret scan | {icon} {detail} |")

    cov = checks.get("coverage") or {}
    if cov.get("status") == "ok" and cov.get("pct") is not None:
        rows.append(f"| Coverage | {cov['pct']}% ({cov.get('tool', '')}) |")

    gen = checks.get("generated") or {}
    if gen and (gen.get("status") != "skip" or gen.get("written")):
        g_status = gen.get("status", "skip")
        fw = gen.get("framework", "")
        label = f"Generated tests ({fw})" if fw and fw != "n/a" else "Generated tests"
        if g_status == "pass":
            rows.append(f"| {label} | ✅ {gen.get('passed', 0)} passed (advisory) |")
        elif g_status == "fail":
            rows.append(
                f"| {label} | ⚠️ {gen.get('summary', 'failed')} (advisory) |"
            )
        else:
            rows.append(f"| {label} | ⏭ {gen.get('summary', 'skipped')} |")
        autofix = gen.get("autofix") if isinstance(gen, dict) else None
        if isinstance(autofix, dict) and autofix.get("status") == "opened":
            url = autofix.get("pr_url") or ""
            link = f"[#{autofix.get('pr_number')}]({url})" if url else "opened"
            rows.append(f"| ↳ Auto-fix PR | 🤖 {link} ({autofix.get('confidence', '')}) |")

    diff = checks.get("diff") or {}
    if diff:
        n = diff.get("changed_files", 0)
        rows.append(f"| Diff | {n} file{'' if n == 1 else 's'} changed |")

    if not rows:
        return []

    out = ["", "**Quality checks**", "", "| Check | Result |", "| --- | --- |"]
    out.extend(rows)

    # Spell out the secret findings — these are the high-signal, blocking
    # ones, so list the offending file:type pairs under the table.
    findings = secrets.get("findings") if isinstance(secrets, dict) else None
    if findings:
        out.append("")
        out.append("> 🔒 **Potential secrets in the diff:**")
        for fnd in findings[:10]:
            out.append(f"> - {fnd}")

    # A failing generated test is advisory but high-signal — it may
    # reproduce a real bug (the seed for the auto-fix builder).
    if gen and gen.get("bug_candidate"):
        out.append("")
        out.append(
            "> 🧪 **A generated test failed** — this may reproduce a real "
            "bug introduced by the diff (advisory). Generated tests are "
            "auto-written and quarantined; review before trusting."
        )
    return out


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
    gate_blocked = summary.get("gate_passed") is False
    if summary.get("app_started"):
        if app_url:
            lines.append(f"| App | ✅ running at port {summary.get('app_port', '?')} |")
        else:
            lines.append("| App | ✅ started — preview URL unavailable |")
    elif gate_blocked:
        lines.append("| App | 🔒 preview withheld |")
    else:
        lines.append(_step_row("App", None, skipped=True))

    if app_url:
        lines.append("")
        lines.append(f"🔗 **[Open Live Preview]({app_url})**")
    elif gate_blocked:
        lines.append("")
        lines.append(
            "🔒 **Preview withheld** — "
            f"{summary.get('gate_reason') or 'checks did not pass'}. "
            "Fix the issue and push again to get a live preview."
        )
    elif summary.get("app_started"):
        lines.append("")
        lines.append("⚠️ App started but preview URL unavailable.")

    lines.extend(_render_checks_section(summary.get("checks") or {}))

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
    stack = summary.get("stack")
    stack_note = f"Stack: {stack} · " if stack and stack != "unknown" else ""
    lines.append(
        f"*{stack_note}Sandbox ran in {duration_ms}ms on EC2 · "
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
            "gate_passed": False,
            "gate_reason": "clone or install failed",
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

    # --- Step A2: detect the stack (Phase 2) ----------------------------
    # One probe round-trip; the orchestrator (not the MCP server) decides
    # which install / test / build commands to run. Falls back to the
    # "unknown" matrix (harmless echoes) if the probe returns nothing.
    detect_resp = _post_execute(
        tunnel_url,
        {
            "type": "run_command",
            "repo": repo,
            "command": _detect_command(pr_number),
        },
    )
    detect_flags = _parse_detect(detect_resp.get("stdout", "") or "")
    stack_label, install_cmd, test_cmd, build_cmd = _stack_commands(
        pr_number, detect_flags
    )
    print(f"[sandbox] detected stack: {stack_label}")

    # --- Step B: install dependencies (best-effort) ---------------------
    install_success = False
    install_output = ""
    if clone_success:
        install_resp = _post_execute(
            tunnel_url,
            {
                "type": "run_command",
                "repo": repo,
                "command": install_cmd,
                # Cargo / maven / dotnet restores can exceed the default
                # 120s run_command cap; give install more room (older MCP
                # servers ignore `timeout` and stay at 120s).
                "timeout": 300,
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
    # Exit-code-aware "did tests pass" signal. Defaults to True so the
    # skipped-test path (clone/install failed) doesn't read as a failure.
    tests_ok = True
    if clone_success and install_success:
        test_resp = _post_execute(
            tunnel_url,
            {
                "type": "run_tests",
                "repo": repo,
                "cwd": cwd,
                # Phase 2: the orchestrator supplies the test command;
                # the MCP server runs it verbatim (older servers re-detect
                # for the big three and use this for everything else).
                "command": test_cmd,
            },
        )
        stdout = test_resp.get("stdout", "") or ""
        stderr = test_resp.get("stderr", "") or ""
        tests_passed, tests_failed = _count_passed_failed(stdout + "\n" + stderr)
        test_output = stdout + ("\n" + stderr if stderr else "")
        if test_resp.get("error"):
            test_output += f"\n[sandbox] mcp error: {test_resp['error']}"
        test_exit_zero = bool(
            test_resp.get("success") is True
            or test_resp.get("exit_code") == 0
        )
        no_tests = _looks_like_no_tests(stdout, stderr) or (
            tests_passed == 0 and tests_failed == 0 and test_exit_zero
        )
        # Tests are OK iff none parsed as failed AND the runner exited 0.
        # The exit-code half catches runners whose output we can't count:
        # a non-zero exit with no parsed failures still flags as failing.
        tests_ok = no_tests or (test_exit_zero and tests_failed == 0)

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
                # Phase 2: orchestrator-supplied build command. Older MCP
                # servers ignore it and fall back to their own detection.
                "command": build_cmd,
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

    # --- Quality checks (Phase 3) ---------------------------------------
    # Diff-aware static analysis + security + coverage, all LEFT of the
    # gate. Run only when clone+install succeeded (lint / typecheck / audit
    # need the deps). Every check is best-effort and tool-guarded; only the
    # diff secret scan can block (per-repo opt-in). The structured results
    # feed the persisted `checks` blob, the PR comment, and the gate.
    checks: dict[str, Any] = {}
    secrets_result: dict[str, Any] = {
        "status": "skip",
        "tool": "regex-diff",
        "count": 0,
        "findings": [],
    }
    if clone_success and install_success:
        comment_token = (
            os.environ.get("GITHUB_TOKEN", "").strip()
            or os.environ.get("GITHUB_TOKEN_PAT", "").strip()
        )
        pr_files = _fetch_pr_files(repo, pr_number, comment_token)
        changed_files = [
            f.get("filename", "")
            for f in pr_files
            if isinstance(f, dict) and f.get("filename")
        ]
        secrets_result = _scan_secrets(pr_files)

        cd_prefix = f"cd {cwd} && "
        lint_result = _run_check(
            tunnel_url, repo, _lint_command(cd_prefix, detect_flags)
        )
        typecheck_result = _run_check(
            tunnel_url, repo, _typecheck_command(cd_prefix, detect_flags)
        )
        audit_result = _run_check(
            tunnel_url, repo, _audit_command(cd_prefix, detect_flags)
        )
        # SAST is the heavy check — EC2 path only (per the plan watch-out),
        # scoped to the PR's changed files, with a longer timeout.
        sast_result = _run_check(
            tunnel_url,
            repo,
            _sast_command(cd_prefix, changed_files),
            timeout=300,
        )
        coverage_result = _parse_coverage(test_output)

        checks = {
            "diff": {"changed_files": len(changed_files), "base": None},
            "lint": lint_result,
            "typecheck": typecheck_result,
            "security": {
                "secrets": secrets_result,
                "audit": audit_result,
                "sast": sast_result,
            },
            "coverage": coverage_result,
        }
        print(
            "[sandbox] checks — "
            f"lint:{lint_result['status']} "
            f"types:{typecheck_result['status']} "
            f"audit:{audit_result['status']} "
            f"sast:{sast_result['status']} "
            f"secrets:{secrets_result['status']}"
            f"({secrets_result.get('count', 0)})"
        )

        # --- Phase 4: Claude-generated tests (advisory, EC2-only) -------
        generated_result, gen_artifacts = _generate_tests_check(
            tunnel_url, repo, cwd, detect_flags, changed_files
        )
        checks["generated"] = generated_result
        print(
            "[sandbox] generated tests: "
            f"{generated_result['status']} "
            f"(wrote {generated_result.get('written', 0)}, "
            f"{generated_result.get('passed', 0)} passed, "
            f"{generated_result.get('failed', 0)} failed)"
        )
        if generated_result.get("bug_candidate") and gen_artifacts:
            # Auto-fix builder (Improvements.md #5): a failing generated test
            # is a candidate reproduced bug. We ask Claude to judge + fix it
            # and open a PR against the contributor's branch. Opt-in via
            # ALLOW_AUTO_FIX_PR; soft-fails so it never breaks the run.
            print(
                "[sandbox] generated-tests: failing case detected — "
                "candidate for auto-fix builder"
            )
            autofix = _autofix_pr(
                repo, pr_number, comment_token, gen_artifacts
            )
            generated_result["autofix"] = autofix
            print(f"[sandbox] auto-fix: {autofix['status']} — {autofix['summary']}")

    # --- Preview gate (Phase 1 + Phase 3) -------------------------------
    # Decide whether the live preview is allowed BEFORE starting the app.
    # Previously the app started whenever clone+install+build passed,
    # regardless of the test outcome — so a PR with failing (or zero)
    # tests still produced a Cloudflare URL. The gate withholds the
    # preview on a real test failure (and, for strict repos, when no
    # tests exist at all). Phase 3 adds a blocking diff secret scan.
    # Config is per-repo via repo_rules.
    (
        block_on_test_failure,
        require_tests_for_preview,
        block_on_secrets,
    ) = _repo_gate_config(repo)
    secrets_blocking_failed = (
        block_on_secrets and secrets_result.get("status") == "fail"
    )
    gate_passed, gate_reason = _compute_gate(
        clone_success=clone_success,
        install_success=install_success,
        build_attempted=build_attempted,
        build_success=build_success,
        tests_failed=tests_failed,
        tests_ok=tests_ok,
        no_tests=no_tests,
        secrets_blocking_failed=secrets_blocking_failed,
        secrets_count=int(secrets_result.get("count", 0) or 0),
        block_on_test_failure=block_on_test_failure,
        require_tests_for_preview=require_tests_for_preview,
    )
    if not gate_passed:
        print(f"[sandbox] preview gate: BLOCKED — {gate_reason}")

    # --- Step E: start app + detect/expose port -------------------------
    # Runs only when the preview gate passed. A blocked gate means a
    # failing build, failing tests, or (strict repos) missing tests — none
    # of which should yield a live preview.
    app_started = False
    app_port: int | None = None
    app_url: str | None = None
    if gate_passed:
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
        tests_ok=tests_ok,
        no_tests=no_tests,
        build_attempted=build_attempted,
        build_success=build_success,
        secrets_blocking_failed=secrets_blocking_failed,
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
        "gate_passed": gate_passed,
        "gate_reason": gate_reason,
        "stack": stack_label,
        "checks": checks,
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
            # Phase 3 columns (migration 022). _upsert_result drops these
            # and retries if the migration hasn't been applied yet.
            "checks": checks,
            "gate_passed": gate_passed,
            "gate_reason": gate_reason,
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
