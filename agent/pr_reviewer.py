"""
Lyncas — autonomous agent that reviews open PRs on configured repos
using Claude, posts the review as a PR comment, and logs work for a daily digest.

Runs hourly via GitHub Actions. Idempotent — won't re-review the same PR.
"""

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Auto-load .env for local/EC2 runs (no-op in GitHub Actions/systemd
# where env vars are injected externally).
try:
    from pathlib import Path as _Path
    from dotenv import load_dotenv as _load_dotenv
    _load_dotenv(_Path(__file__).parent / ".env", override=True)
except ImportError:
    pass

import requests
from anthropic import Anthropic
from supabase import Client, create_client

# Phase 6: review now runs through a LangGraph reviewer→critic→(arbiter)→final
# graph. review_pr_with_claude is preserved (benchmark.py still uses it as the
# single-pass baseline) but main() invokes the graph instead.
from review_graph import run_review_graph

# --- Config ---------------------------------------------------------------

ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
# Legacy / fallback GitHub PAT. In single-tenant deployments (REPOS env var
# set) every API call uses this. In multi-tenant deployments (REPOS unset,
# repos sourced from `watched_repos`) it's only a last-resort fallback when
# a watched_repos row has neither a PAT nor a GitHub App installation.
# Made optional at import time so a multi-tenant deploy that never wants
# to fall back to a shared PAT can simply leave it unset.
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN_PAT", "")
REPOS = [r.strip() for r in os.environ.get("REPOS", "").split(",") if r.strip()]  # e.g. "user/repo1,user/repo2"

# GitHub App credentials (used when a watched_repos row has
# token_type='github_app'). Both are optional — if unset, the agent
# falls through to GITHUB_TOKEN_PAT for app-typed rows and prints a
# WARN at startup. Mirrors the dashboard's dashboard/lib/github-app.ts
# JWT signing so both sides authenticate as the same App.
GITHUB_APP_ID = os.environ.get("GITHUB_APP_ID", "")
GITHUB_APP_PRIVATE_KEY = os.environ.get("GITHUB_APP_PRIVATE_KEY", "")

# --- Auto-close gates ---
# All three must be true for the agent to close a PR. Set ALLOW_AUTO_CLOSE=true in
# workflow env to enable. Defaults to false — the agent will never close anything
# unless you explicitly opt in.
ALLOW_AUTO_CLOSE = os.environ.get("ALLOW_AUTO_CLOSE", "false").lower() == "true"
AUTO_CLOSE_MIN_SEVERITY = 9   # severity_score must be >= this
AUTO_CLOSE_REQUIRED_VERDICT = "request_changes"
AUTO_CLOSE_REQUIRED_CONFIDENCE = "high"

# claude-opus-4-5: ~5x cost of Sonnet but meaningfully better bug detection.
# Benchmark (n=5) showed 100% verdict agreement but low bug overlap on complex PRs.
# For deep review where the bug list IS the deliverable, Opus wins.
# Switch back to Sonnet if monthly cost exceeds budget threshold.
MODEL = "claude-opus-4-5"
MAX_DIFF_CHARS = 60_000  # truncate huge PRs to control token cost
REVIEW_MARKER = "<!-- night-pr-reviewer:v1 -->"  # used to detect prior reviews
CLOSE_MARKER = "<!-- night-pr-reviewer:closed:v1 -->"  # used to detect prior auto-close

# --- Pricing (USD per 1M tokens) -------------------------------------------
# Used to compute the per-review cost line in the PR comment footer and in
# the digest email. Sourced from Anthropic's public pricing page. Keep in
# sync with agent/benchmark.py's PRICING_MICROS dict (same numbers, different
# units). Update when Anthropic ships a new price card.
MODEL_PRICING_USD_PER_M_TOKENS = {
    "claude-opus-4-5":   {"input": 15.0, "output": 75.0},
    "claude-sonnet-4-5": {"input": 3.0,  "output": 15.0},
}

# --- Severity → emoji ------------------------------------------------------
# Used by the rich PR comment renderer (Phase 3). The keys here must match
# the per-bug severity values produced by the prompt.md schema.
SEVERITY_EMOJI = {
    "critical": "🔥",
    "high":     "🔴",
    "medium":   "🟠",
    "low":      "🟡",
}
SEVERITY_ORDER = ("critical", "high", "medium", "low")

# --- Repo fingerprint (Phase 2) -------------------------------------------
# A "fingerprint" is a compact Claude-generated summary of what a repo IS,
# injected into the review prompt so the reviewer knows whether a given diff
# is in-character. Generated once per repo via shallow clone + summarizer,
# cached in Supabase for FINGERPRINT_TTL_DAYS, regenerated on cache miss.
FINGERPRINT_TTL_DAYS = 7
FINGERPRINT_README_MAX_CHARS = 3000
FINGERPRINT_DEP_FILE_MAX_CHARS = 4000
FINGERPRINT_DIR_DEPTH = 2
FINGERPRINT_DIR_MAX_ENTRIES = 200
FINGERPRINT_MAX_OUTPUT_TOKENS = 1200
FINGERPRINT_CLONE_TIMEOUT_SEC = 60

# Dep files we look for, in priority order. The first one that exists wins —
# most repos have exactly one, and if a polyglot has several we only need one
# to convey "this is a Node project" / "this is a Python project" / etc.
FINGERPRINT_DEP_FILES = (
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "Cargo.toml",
    "Gemfile",
    "pom.xml",
    "build.gradle",
)

# Directories we skip when listing repo structure — none of these tell the
# reviewer anything useful about the repo's intent, and several would blow
# past FINGERPRINT_DIR_MAX_ENTRIES on their own (node_modules in particular).
FINGERPRINT_SKIP_DIRS = frozenset({
    ".git",
    "node_modules",
    "venv",
    ".venv",
    "__pycache__",
    "dist",
    "build",
    ".next",
    "target",
    ".cache",
    "coverage",
    ".pytest_cache",
    ".mypy_cache",
    ".idea",
    ".vscode",
})

# System prompt for the fingerprint summarizer. Hardcoded (not in prompt.md)
# because prompt.md is the *reviewer* prompt; mixing summarizer instructions
# into it would dilute both. See IMPROVEMENTS_v2.md Phase 2 for the exact
# wording requirements.
FINGERPRINT_SUMMARIZER_SYSTEM_PROMPT = """\
You are summarizing a software repository for use as context in code reviews.
Given the README, dependency file, and directory structure below, produce a
compact summary (max 500 words) covering:
- What this project does (1-2 sentences)
- Tech stack (languages, frameworks, key dependencies)
- Key directories and what they contain
- Conventions you can infer (naming patterns, test locations, config approach)
- What kinds of changes would be OUT OF SCOPE for this repo

Be specific and factual. Do not add opinions or suggestions."""

GITHUB_API = "https://api.github.com"


def gh_headers(token: str = "") -> dict:
    """Headers for a GitHub API call authenticated as the supplied token.

    Empty string falls back to the module-level GITHUB_TOKEN so legacy
    single-tenant callers (REPOS env var path, benchmark.py, prompt_tuner.py)
    that pre-date the multi-tenant token plumbing keep working byte-for-byte.
    A truly missing token (both arg and module-level empty) still produces a
    header — the call will just fail with 401 from GitHub, which is the
    safest failure mode (visible, attributable)."""
    tok = token or GITHUB_TOKEN
    return {
        "Authorization": f"Bearer {tok}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


# Kept as a module-level constant so callers that imported it
# (benchmark.py, prompt_tuner.py, internal helpers) don't break. New code
# should use gh_headers(token) instead.
GH_HEADERS = gh_headers(GITHUB_TOKEN)

client = Anthropic(api_key=ANTHROPIC_API_KEY)


# --- Multi-tenant: GitHub App JWT + installation token --------------------
# Mirrors dashboard/lib/github-app.ts byte-for-byte where it counts:
#   * RS256 with base64url segments
#   * iss MUST be a JSON number (GitHub 401s otherwise with "could not be
#     decoded")
#   * iat backdated 60s for clock skew, exp 600s in the future
# We use the `cryptography` package, which `supabase` already pulls in as
# a transitive dep — so no new requirements entry is needed. If it's
# missing in some environment, the get_installation_token call fails with
# a clear ImportError surfaced at first use, not at module load.

# In-memory installation-token cache. Tokens are ~1h-lived; one cron run is
# minutes. We re-use within a run so a repo with 10 open PRs only mints
# once. {installation_id: (token, expires_at_epoch_seconds)}.
_INSTALLATION_TOKEN_CACHE: dict[int, tuple[str, float]] = {}


def _b64url(data: bytes) -> str:
    """RFC 7515 base64url-without-padding. JWT segments use this exact
    encoding. Stdlib's urlsafe_b64encode gives us URL-safe alphabet but
    keeps trailing '=' padding — strip it explicitly."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _sign_app_jwt() -> str:
    """Sign a short-lived RS256 App JWT against GITHUB_APP_PRIVATE_KEY.

    Same shape as dashboard/lib/github-app.ts:getAppJWT() — iss is the
    integer App ID (NOT a string), iat is backdated 60s, exp is +600s.
    Raises ValueError when env vars are missing or malformed."""
    if not GITHUB_APP_ID or not GITHUB_APP_PRIVATE_KEY:
        raise ValueError(
            "GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY not set; "
            "cannot mint installation token"
        )
    try:
        iss = int(GITHUB_APP_ID)
    except ValueError as e:
        raise ValueError(
            f"GITHUB_APP_ID must be an integer, got {GITHUB_APP_ID!r}"
        ) from e

    # Vercel-style envs store the .pem with literal '\n' between lines.
    # Both that and the real-newline form must work.
    key_pem = GITHUB_APP_PRIVATE_KEY
    if "\\n" in key_pem and "\n" not in key_pem:
        key_pem = key_pem.replace("\\n", "\n")

    # Local import: cryptography is a transitive dep of supabase; importing
    # at module top would force every CI job (including ones that never
    # mint tokens) to install it. Lazy-loading keeps the import surface
    # minimal and surfaces a precise error if it's somehow missing.
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    private_key = serialization.load_pem_private_key(
        key_pem.encode("utf-8"), password=None
    )

    now = int(time.time())
    header = {"alg": "RS256", "typ": "JWT"}
    payload = {"iat": now - 60, "exp": now + 600, "iss": iss}

    header_b64 = _b64url(json.dumps(header, separators=(",", ":")).encode())
    payload_b64 = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    signature = private_key.sign(  # type: ignore[union-attr]
        signing_input, padding.PKCS1v15(), hashes.SHA256()
    )
    return f"{header_b64}.{payload_b64}.{_b64url(signature)}"


def get_installation_token(installation_id: int) -> str:
    """Mint (or return a cached) installation access token for the given
    GitHub App installation. Tokens are valid for ~1h; we cache in-process
    until 60s before expiry.

    Raises on any failure (missing config, bad JWT, GitHub error). Callers
    fall back to a static PAT on exception."""
    cached = _INSTALLATION_TOKEN_CACHE.get(installation_id)
    if cached and cached[1] - 60 > time.time():
        return cached[0]

    jwt = _sign_app_jwt()
    r = requests.post(
        f"{GITHUB_API}/app/installations/{installation_id}/access_tokens",
        headers={
            "Authorization": f"Bearer {jwt}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    token = data["token"]
    # GitHub returns ISO-8601 with a trailing 'Z'.
    exp_iso = data.get("expires_at") or ""
    try:
        exp_dt = datetime.fromisoformat(exp_iso.replace("Z", "+00:00"))
        exp_epoch = exp_dt.timestamp()
    except Exception:
        # Conservative fallback: 50 minutes from now (GitHub's docs say ~1h).
        exp_epoch = time.time() + 50 * 60
    _INSTALLATION_TOKEN_CACHE[installation_id] = (token, exp_epoch)
    return token


# --- Multi-tenant: watched_repos source of truth --------------------------

def get_watched_repos() -> list[dict]:
    """Return enabled watched_repos rows: [{repo, github_token,
    github_installation_id, token_type, user_id}, ...].

    Empty list when Supabase is unavailable or no enabled rows exist. The
    caller (main) is responsible for falling back to the REPOS env var
    when this returns [] AND REPOS is set.

    The query is service-role (RLS bypassed) — see CLAUDE.md: the agent
    runs with SUPABASE_SERVICE_KEY and is authorized to see every row."""
    if supabase is None:
        return []
    try:
        resp = (
            supabase.table("watched_repos")
            .select(
                "repo, github_token, github_installation_id, token_type, user_id"
            )
            .eq("enabled", True)
            .execute()
        )
    except Exception as e:
        print(f"[ERROR] Could not query watched_repos: {e}", file=sys.stderr)
        return []
    return list(resp.data or [])


def resolve_repo_token(row: dict) -> str:
    """Given one watched_repos row, return the GitHub token to use for
    this repo. Precedence:
      1. github_app installation token (minted on demand)
      2. row's `github_token` (PAT-typed rows)
      3. module-level GITHUB_TOKEN (last-resort static PAT)
    Returns "" only when none of the above are available — the caller
    logs and skips."""
    token_type = (row.get("token_type") or "pat").lower()
    if token_type == "github_app":
        iid = row.get("github_installation_id")
        if iid:
            try:
                return get_installation_token(int(iid))
            except Exception as e:
                print(
                    f"  [{row.get('repo', '?')}] installation token mint failed "
                    f"(installation_id={iid}): {e}",
                    file=sys.stderr,
                )
        # fall through to PAT-style fallbacks
    pat = (row.get("github_token") or "").strip()
    if pat:
        return pat
    return GITHUB_TOKEN


# --- Supabase state -------------------------------------------------------
# Optional: if SUPABASE_URL / SUPABASE_SERVICE_KEY are unset, the agent still
# reviews PRs (the GitHub-side actions don't need a DB). We just skip the
# state writes and warn at startup. Losing the DB row is recoverable; losing
# the run is not (see IMPROVEMENTS.md Phase 2, requirement #7).

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")

supabase: Client | None = None
if SUPABASE_URL and SUPABASE_SERVICE_KEY:
    try:
        supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    except Exception as e:
        print(f"[ERROR] Failed to initialize Supabase client: {e}", file=sys.stderr)
else:
    print(
        "[WARN] SUPABASE_URL or SUPABASE_SERVICE_KEY is unset — "
        "agent will review PRs but will not persist state to Supabase",
        file=sys.stderr,
    )


def insert_run(repos_scanned: list[str] | None = None) -> str | None:
    """Insert a fresh row into `runs` and return its id (None on failure).

    `repos_scanned` defaults to the module-level REPOS list. The webhook
    path (PR_FILTER_REPO/NUMBER set) passes the single-element list it's
    actually scanning so the dashboard's run history reflects what the
    run did, not what the env would have allowed."""
    if supabase is None:
        return None
    try:
        resp = (
            supabase.table("runs")
            .insert(
                {
                    "trigger_source": os.environ.get("GITHUB_EVENT_NAME", "unknown"),
                    "repos_scanned": repos_scanned if repos_scanned is not None else REPOS,
                }
            )
            .execute()
        )
        return resp.data[0]["id"] if resp.data else None
    except Exception as e:
        print(f"[ERROR] Could not insert runs row: {e}", file=sys.stderr)
        return None


def finalize_run(
    run_id: str | None,
    reviews_created: int,
    skipped: int,
    errors: list[dict],
) -> None:
    """Patch the runs row with end-of-run counters. Soft-fails on DB error."""
    if supabase is None or run_id is None:
        return
    try:
        supabase.table("runs").update(
            {
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "reviews_created": reviews_created,
                "skipped": skipped,
                "errors": errors if errors else None,
            }
        ).eq("id", run_id).execute()
    except Exception as e:
        print(f"[ERROR] Could not finalize runs row {run_id}: {e}", file=sys.stderr)


def upsert_review(
    *,
    pr: dict,
    repo: str,
    review: dict,
    action: str,
    gate_reason: str,
    user_id: str | None = None,
) -> None:
    """Upsert one row in `reviews`. Re-reviews of the same (repo, pr_number)
    overwrite cleanly via the unique index. Raises on failure — the caller
    decides how to handle (the GitHub comment has already been posted).

    `user_id` is the watched_repos.user_id that owns this repo (multi-tenant
    path). NULL for legacy REPOS-env-var runs; the dashboard's user-scoped
    views explicitly include `user_id IS NULL` so those rows stay visible."""
    if supabase is None:
        return
    # Phase 3: persist enough metadata for the digest to render the new
    # per-card extras (model name for cost, repo-context badge).
    fingerprint_status = review.get("_fingerprint_status") or "unavailable"
    payload = {
        "repo": repo,
        "pr_number": pr["number"],
        "pr_url": pr["html_url"],
        "pr_title": pr["title"],
        "pr_author": pr.get("user", {}).get("login"),
        "verdict": review["verdict"],
        "confidence": review["confidence"],
        "severity_score": review.get("severity_score"),
        "summary": review["summary"],
        "bug_count": len(review.get("bugs") or []),
        "bugs": review.get("bugs"),
        "concerns": review.get("concerns"),
        "questions": review.get("questions"),
        "praise": review.get("praise"),
        "action": action,
        "gate_reason": gate_reason or None,
        "input_tokens": review.get("_input_tokens"),
        "output_tokens": review.get("_output_tokens"),
        "truncated": review.get("_truncated", False),
        "repo_context_used": fingerprint_status in ("cached", "fresh"),
        "model": review.get("_model") or MODEL,
        # Phase 6: persist the per-node JSON outputs so the /pr/[id] page can
        # render the agent's deliberation (reviewer vs critic vs arbiter).
        # All three default to NULL/false for pre-Phase-6 rows and for the
        # webhook path (which intentionally still runs single-pass).
        "critic_output": review.get("_critic_output"),
        "arbiter_output": review.get("_arbiter_output"),
        "escalated": bool(review.get("_escalated", False)),
    }
    # Only include user_id when we actually have one. Setting it to NULL
    # explicitly on a re-review of a legacy row would clobber a previous
    # SaaS-aware write — leave it out and let the existing value stand.
    if user_id:
        payload["user_id"] = user_id
    supabase.table("reviews").upsert(payload, on_conflict="repo,pr_number").execute()


# --- GitHub helpers -------------------------------------------------------

def list_open_prs(repo: str, token: str = "") -> list[dict]:
    """Return list of open PRs (excluding drafts) for a repo."""
    r = requests.get(
        f"{GITHUB_API}/repos/{repo}/pulls",
        headers=gh_headers(token),
        params={"state": "open", "per_page": 30},
        timeout=30,
    )
    r.raise_for_status()
    return [pr for pr in r.json() if not pr.get("draft")]


def get_pr(repo: str, pr_number: int, token: str = "") -> dict:
    """Fetch a single PR by number. Used by the webhook-triggered path
    (agent/webhook_handler.py) when PR_FILTER_REPO + PR_FILTER_NUMBER
    scope this invocation to one specific PR — we don't need the full
    open-PR list, and the targeted PR may not even be in it (drafts,
    just-closed, etc.). Drafts are NOT filtered here; the cron path's
    draft filter is in list_open_prs(), but if a webhook explicitly
    asks us to review a draft we honor that."""
    r = requests.get(
        f"{GITHUB_API}/repos/{repo}/pulls/{pr_number}",
        headers=gh_headers(token),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def already_reviewed(repo: str, pr_number: int, token: str = "") -> bool:
    """Check if we've already touched this PR (review or close marker)."""
    r = requests.get(
        f"{GITHUB_API}/repos/{repo}/issues/{pr_number}/comments",
        headers=gh_headers(token),
        params={"per_page": 100},
        timeout=30,
    )
    r.raise_for_status()
    return any(
        REVIEW_MARKER in c.get("body", "") or CLOSE_MARKER in c.get("body", "")
        for c in r.json()
    )


def get_pr_diff(repo: str, pr_number: int, token: str = "") -> str:
    """Fetch the raw unified diff for a PR."""
    headers = gh_headers(token)
    headers["Accept"] = "application/vnd.github.v3.diff"
    r = requests.get(
        f"{GITHUB_API}/repos/{repo}/pulls/{pr_number}",
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.text


def post_review_comment(repo: str, pr_number: int, body: str, token: str = "") -> None:
    """Post the review as a regular PR comment."""
    r = requests.post(
        f"{GITHUB_API}/repos/{repo}/issues/{pr_number}/comments",
        headers=gh_headers(token),
        json={"body": body},
        timeout=30,
    )
    r.raise_for_status()


def close_pr(repo: str, pr_number: int, reason_comment: str, token: str = "") -> None:
    """Post a reason comment, then close the PR. Order matters — comment first
    so the author sees the explanation when they get the close notification."""
    post_review_comment(repo, pr_number, reason_comment, token=token)
    r = requests.patch(
        f"{GITHUB_API}/repos/{repo}/pulls/{pr_number}",
        headers=gh_headers(token),
        json={"state": "closed"},
        timeout=30,
    )
    r.raise_for_status()


def should_auto_close(
    review: dict,
    rules: dict | None = None,
) -> tuple[bool, str]:
    """Apply the three-gate check. Returns (should_close, reason_if_not).

    Phase 9: when `rules` is passed (from get_repo_rules) the per-repo
    overrides apply:
      * rules['auto_close_all']=True bypasses every gate and closes.
      * rules['auto_close_severity_threshold']=N replaces the global
        AUTO_CLOSE_MIN_SEVERITY constant for THIS PR only.
    ALLOW_AUTO_CLOSE is still the outer kill-switch — if it's false the
    function returns False regardless of repo rules. That matches the
    documented constraint in CLAUDE.md: the global auto-close gate is
    never loosened without explicit operator intent."""
    if not ALLOW_AUTO_CLOSE:
        return False, "ALLOW_AUTO_CLOSE is false (default)"

    rules = rules or {}

    if rules.get("auto_close_all"):
        return True, "auto_close_all=true (repo rules override)"

    score = review.get("severity_score", 0)
    verdict = review.get("verdict", "")
    confidence = review.get("confidence", "")

    min_severity = (
        rules.get("auto_close_severity_threshold")
        or AUTO_CLOSE_MIN_SEVERITY
    )

    failed = []
    if verdict != AUTO_CLOSE_REQUIRED_VERDICT:
        failed.append(f"verdict={verdict} (need {AUTO_CLOSE_REQUIRED_VERDICT})")
    if confidence != AUTO_CLOSE_REQUIRED_CONFIDENCE:
        failed.append(f"confidence={confidence} (need {AUTO_CLOSE_REQUIRED_CONFIDENCE})")
    if not isinstance(score, int) or score < min_severity:
        failed.append(f"severity={score} (need >= {min_severity})")

    if failed:
        return False, "; ".join(failed)
    return True, ""


# --- Phase 9: per-repo rules ---------------------------------------------
# Per-repo configuration is written by the dashboard's
# /repos/<owner>/<name>/settings page into the repo_rules Supabase table
# (see agent/migrations/009_repo_rules.sql) and read here once per repo
# per run. Cache hits are free; cache misses do one Supabase select.
#
# The rules dict shape is the canonical interchange — callers never
# touch the Supabase row directly. Default values match the migration's
# column defaults so an absent row and an all-default row behave
# identically.

REPO_RULES_DEFAULTS: dict = {
    "enabled": True,
    "auto_close_all": False,
    "watch_paths": [],
    "skip_paths": [],
    "custom_instructions": None,
    "rules_file_content": None,
    "auto_close_severity_threshold": None,
    "repo_directory_tree": None,
}


def get_repo_rules(repo: str) -> dict:
    """Return the rules dict for `repo`. Falls back to defaults if no row
    exists, if Supabase is offline, or if the table itself is missing
    (so the agent works against a not-yet-migrated database — the only
    consequence is that no repo gets any non-default behavior)."""
    if supabase is None:
        return dict(REPO_RULES_DEFAULTS)
    try:
        resp = (
            supabase.table("repo_rules")
            .select("*")
            .eq("repo", repo)
            .maybe_single()
            .execute()
        )
    except Exception as e:
        print(f"  [{repo}] could not load repo rules: {e}", file=sys.stderr)
        return dict(REPO_RULES_DEFAULTS)
    data = getattr(resp, "data", None)
    if not data:
        return dict(REPO_RULES_DEFAULTS)
    merged = dict(REPO_RULES_DEFAULTS)
    merged.update({k: v for k, v in data.items() if k in REPO_RULES_DEFAULTS})
    # Empty arrays come back as [] from Postgres — leave them as-is so
    # `if rules['watch_paths']:` checks short-circuit correctly.
    return merged


def upsert_repo_directory_tree(repo: str, tree_text: str) -> None:
    """Persist the observed directory list back to repo_rules so the
    dashboard's read-only structure view can render it. Best-effort:
    silently no-ops if Supabase is offline or the table is missing.
    Creates the row if one doesn't exist yet (with rules at defaults)
    so a brand-new repo's tree is recorded without forcing the operator
    to visit /settings first."""
    if supabase is None or not tree_text:
        return
    try:
        supabase.table("repo_rules").upsert(
            {"repo": repo, "repo_directory_tree": tree_text},
            on_conflict="repo",
        ).execute()
    except Exception as e:
        print(
            f"  [{repo}] could not save repo_directory_tree: {e}",
            file=sys.stderr,
        )


def _extract_files_from_diff(diff: str) -> list[str]:
    """Pull the list of B-side file paths out of a unified diff.

    A git diff starts each file block with:
        diff --git a/<path> b/<path>
    We use the B path (post-change) so renamed/deleted files map to
    their final identity. Returns a deduplicated list in source order."""
    seen: set[str] = set()
    out: list[str] = []
    for line in diff.split("\n"):
        if not line.startswith("diff --git "):
            continue
        marker = " b/"
        idx = line.rfind(marker)
        if idx == -1:
            continue
        path = line[idx + len(marker):].strip()
        if path and path not in seen:
            seen.add(path)
            out.append(path)
    return out


def _path_matches_any(path: str, prefixes: list[str]) -> bool:
    """True if `path` is covered by ANY entry in `prefixes`.

    Entries are either exact file names (`README.md`), directory paths
    with or without a trailing slash (`docs/`, `docs`), or path
    prefixes. Matching rules:
      - 'README.md' matches exactly 'README.md'
      - 'docs/' (or 'docs') matches 'docs', 'docs/foo', 'docs/foo/bar'
    Empty prefixes are skipped so a stray blank line in the textarea
    can't accidentally widen the filter to everything."""
    for raw in prefixes:
        p = raw.strip()
        if not p:
            continue
        if p.endswith("/"):
            p = p[:-1]
        if path == p or path.startswith(p + "/"):
            return True
    return False


def _directory_tree_from_files(files: list[str]) -> str:
    """Return a newline-joined, sorted list of unique directory paths
    observed in `files` (root files are recorded as './'). Used for the
    /settings page's read-only structure view — operators copy lines
    out of here into watch_paths / skip_paths."""
    dirs: set[str] = set()
    has_root = False
    for f in files:
        if "/" not in f:
            has_root = True
            continue
        parts = f.split("/")
        # Every prefix is interesting — operators may want to scope
        # rules to 'src/' or 'src/api/' depending on the change.
        for i in range(1, len(parts)):
            dirs.add("/".join(parts[:i]) + "/")
    out = sorted(dirs)
    if has_root:
        out.insert(0, "./")
    return "\n".join(out)


def _build_operator_rules_block(rules: dict) -> str:
    """Render custom_instructions + rules_file_content as a single
    OPERATOR RULES block to prepend to the diff. Returns an empty
    string when neither is set, so the prompt is byte-identical to
    the pre-Phase-9 prompt for repos with no rules configured."""
    parts: list[str] = []
    custom = (rules.get("custom_instructions") or "").strip()
    file_content = (rules.get("rules_file_content") or "").strip()
    if custom:
        parts.append(custom)
    if file_content:
        parts.append(file_content)
    if not parts:
        return ""
    body = "\n\n".join(parts)
    return f"OPERATOR RULES:\n{body}\n---\n\n"


# --- Repo fingerprint -----------------------------------------------------
# Phase 2: shallow-clone each repo once a week, ask Claude to write a compact
# summary, cache it in Supabase, and prepend it to every review prompt. The
# whole thing is best-effort — any failure (no Supabase, no git, clone error,
# Claude error, missing files) is logged and we proceed without context.

def _read_optional_text(path: Path, max_chars: int) -> str:
    """Read a text file if it exists; return "" on any error. Capped at
    max_chars so a 5MB README doesn't blow up the summarizer prompt."""
    try:
        if not path.is_file():
            return ""
        return path.read_text(encoding="utf-8", errors="replace")[:max_chars]
    except Exception:
        return ""


def _read_readme(repo_dir: Path) -> str:
    """Pick the first README variant that exists. Case matters on Linux so
    we try common casings explicitly — git on macOS would mask this bug."""
    for name in ("README.md", "Readme.md", "readme.md", "README", "README.rst"):
        text = _read_optional_text(repo_dir / name, FINGERPRINT_README_MAX_CHARS)
        if text:
            return text
    return ""


def _read_dep_file(repo_dir: Path) -> str:
    """Return the first dep file we find, formatted as `=== name ===\\n<body>`.
    Returns "" if none of the candidates exist."""
    for name in FINGERPRINT_DEP_FILES:
        body = _read_optional_text(repo_dir / name, FINGERPRINT_DEP_FILE_MAX_CHARS)
        if body:
            return f"=== {name} ===\n{body}"
    return ""


def _list_repo_tree(repo_dir: Path, max_depth: int, max_entries: int) -> str:
    """Indented `name/` listing of the repo, two levels deep by default.
    Skips noise dirs (FINGERPRINT_SKIP_DIRS) and hidden files except .github."""
    lines: list[str] = []

    def walk(d: Path, level: int, prefix: str) -> None:
        if len(lines) >= max_entries:
            return
        try:
            entries = sorted(d.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except OSError:
            return
        for entry in entries:
            if len(lines) >= max_entries:
                return
            name = entry.name
            if name in FINGERPRINT_SKIP_DIRS:
                continue
            # Skip hidden files / dotfiles, but keep .github (CI config is
            # genuinely useful context for "what kind of repo is this")
            if name.startswith(".") and name != ".github":
                continue
            kind = "/" if entry.is_dir() else ""
            lines.append(f"{prefix}{name}{kind}")
            if entry.is_dir() and level < max_depth:
                walk(entry, level + 1, prefix + "  ")

    walk(repo_dir, 1, "")
    if len(lines) >= max_entries:
        lines.append(f"... (truncated at {max_entries} entries)")
    return "\n".join(lines)


def _git_head_sha(repo_dir: Path) -> str | None:
    """HEAD SHA of the cloned repo, or None if `git rev-parse` fails."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(repo_dir),
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.stdout.strip() or None
    except Exception:
        return None


def _fingerprint_cache_lookup(repo: str) -> str | None:
    """Return the cached fingerprint for `repo` if it exists and is fresher
    than FINGERPRINT_TTL_DAYS. Returns None on miss, stale row, or any error
    (errors fall through to a regenerate attempt)."""
    if supabase is None:
        return None
    try:
        res = (
            supabase.table("repo_fingerprints")
            .select("fingerprint, last_updated")
            .eq("repo", repo)
            .limit(1)
            .execute()
        )
    except Exception as e:
        print(f"  [fingerprint:{repo}] cache lookup failed: {e}", file=sys.stderr)
        return None

    rows = res.data or []
    if not rows:
        return None
    row = rows[0]
    last = row.get("last_updated")
    if not last:
        return None
    try:
        # Supabase returns ISO 8601 with a trailing 'Z' or '+00:00'.
        last_dt = datetime.fromisoformat(last.replace("Z", "+00:00"))
    except Exception:
        return None
    age = datetime.now(timezone.utc) - last_dt
    if age < timedelta(days=FINGERPRINT_TTL_DAYS):
        return row.get("fingerprint")
    return None


def _summarize_repo_with_claude(readme: str, deps: str, dir_listing: str) -> str:
    """Call Claude to produce the compact fingerprint. Raises on API failure;
    the caller decides whether to swallow."""
    parts: list[str] = []
    if readme:
        parts.append(f"=== README (first {FINGERPRINT_README_MAX_CHARS} chars) ===\n{readme}")
    if deps:
        parts.append(deps)
    if dir_listing:
        parts.append(f"=== Directory structure (depth {FINGERPRINT_DIR_DEPTH}) ===\n{dir_listing}")
    user_msg = "\n\n".join(parts)

    response = client.messages.create(
        model=MODEL,
        max_tokens=FINGERPRINT_MAX_OUTPUT_TOKENS,
        system=FINGERPRINT_SUMMARIZER_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_msg}],
    )
    return response.content[0].text.strip()


def get_or_refresh_fingerprint(
    repo: str, token: str = ""
) -> tuple[str | None, str]:
    """Return ``(fingerprint, status)`` for the repo. Regenerates via shallow
    clone if the cached row is missing or older than FINGERPRINT_TTL_DAYS.

    `status` is one of:
      - ``"cached"``      — used the existing Supabase row (cache hit)
      - ``"fresh"``       — generated a new fingerprint this run
      - ``"unavailable"`` — generation failed at some step; ``fingerprint`` is None

    Phase 3 plumbs `status` into the PR review comment footer and into the
    digest's per-card badge. The Phase 2 graceful-degradation contract is
    unchanged: on any failure the caller proceeds with no repo context.
    """
    if supabase is None:
        # No DB → no cache layer to read or write. We *could* clone + summarize
        # every run, but that would be ~30s per repo per run and never reused.
        # Skip silently; the WARN at startup already covered the DB-missing case.
        return None, "unavailable"

    cached = _fingerprint_cache_lookup(repo)
    if cached:
        print(f"  [fingerprint:{repo}] using cached fingerprint ({len(cached.split())} words)")
        return cached, "cached"

    clone_token = token or GITHUB_TOKEN
    if not clone_token:
        print(
            f"  [fingerprint:{repo}] no repo token — cannot clone, "
            f"proceeding without repo context",
            file=sys.stderr,
        )
        return None, "unavailable"

    slug = repo.replace("/", "-")
    clone_dir = Path(tempfile.mkdtemp(prefix=f"fp-{slug}-"))

    try:
        # x-access-token is the documented basic-auth username for token-auth
        # clones (works for classic PATs, fine-grained PATs, AND GitHub App
        # installation tokens). The token itself is the password.
        clone_url = f"https://x-access-token:{clone_token}@github.com/{repo}.git"
        print(f"  [fingerprint:{repo}] cache miss/stale — shallow cloning...")
        try:
            subprocess.run(
                ["git", "clone", "--depth=1", clone_url, str(clone_dir)],
                check=True,
                capture_output=True,
                text=True,
                timeout=FINGERPRINT_CLONE_TIMEOUT_SEC,
            )
        except subprocess.CalledProcessError as e:
            # stderr can leak the PAT in some failure modes (e.g. "fatal:
            # could not read Username for 'https://...:***'") — git redacts
            # the token by default, but be defensive and only log the tail.
            stderr_tail = ((e.stderr or "")[-400:]).strip()
            print(
                f"  [fingerprint:{repo}] clone failed (exit {e.returncode}): {stderr_tail}",
                file=sys.stderr,
            )
            return None, "unavailable"
        except subprocess.TimeoutExpired:
            print(
                f"  [fingerprint:{repo}] clone timed out after "
                f"{FINGERPRINT_CLONE_TIMEOUT_SEC}s",
                file=sys.stderr,
            )
            return None, "unavailable"

        readme = _read_readme(clone_dir)
        deps = _read_dep_file(clone_dir)
        dir_listing = _list_repo_tree(
            clone_dir, FINGERPRINT_DIR_DEPTH, FINGERPRINT_DIR_MAX_ENTRIES
        )

        if not readme and not deps:
            # Nothing useful to summarize. Don't waste a Claude call.
            print(
                f"  [fingerprint:{repo}] no README or dep file found — "
                f"skipping fingerprint",
                file=sys.stderr,
            )
            return None, "unavailable"

        commit_sha = _git_head_sha(clone_dir)

        try:
            fingerprint = _summarize_repo_with_claude(readme, deps, dir_listing)
        except Exception as e:
            print(f"  [fingerprint:{repo}] summarizer call failed: {e}", file=sys.stderr)
            return None, "unavailable"

        if not fingerprint:
            print(f"  [fingerprint:{repo}] summarizer returned empty text", file=sys.stderr)
            return None, "unavailable"

        token_count = len(fingerprint.split())

        try:
            supabase.table("repo_fingerprints").upsert(
                {
                    "repo": repo,
                    "fingerprint": fingerprint,
                    "last_updated": datetime.now(timezone.utc).isoformat(),
                    "commit_sha": commit_sha,
                    "token_count": token_count,
                },
                on_conflict="repo",
            ).execute()
            print(
                f"  [fingerprint:{repo}] generated & cached "
                f"({token_count} words, sha={commit_sha[:7] if commit_sha else '?'})"
            )
        except Exception as e:
            # Caching failed but we still have the fingerprint in memory — use
            # it for this run; the next run will retry the cache write.
            print(
                f"  [fingerprint:{repo}] cache write failed: {e} "
                f"(using fingerprint for this run anyway)",
                file=sys.stderr,
            )

        return fingerprint, "fresh"
    finally:
        # Always clean up the temp clone — these can be hundreds of MB and
        # GitHub Actions runners have limited disk.
        shutil.rmtree(clone_dir, ignore_errors=True)


# --- Claude review --------------------------------------------------------

def load_prompt() -> str:
    return (Path(__file__).parent / "prompt.md").read_text(encoding="utf-8")


def review_pr_with_claude(
    pr: dict,
    diff: str,
    model: str = MODEL,
    repo_fingerprint: str | None = None,
) -> dict:
    """Ask Claude to review the diff. Returns dict with review fields.

    `model` defaults to the production model (MODEL) but is parameterised so
    benchmark.py can re-run the same prompt against Opus without duplicating
    this function. Everything else (prompt, parsing, output shape) is identical
    across models — that's the whole point of the benchmark.

    `repo_fingerprint` is the optional Phase-2 context block. When provided,
    it's prepended to the user message so the reviewer knows what kind of repo
    this is (stack, conventions, what's in/out of scope). When None, the prompt
    falls back to the pre-Phase-2 shape — graceful degradation."""
    truncated = False
    if len(diff) > MAX_DIFF_CHARS:
        diff = diff[:MAX_DIFF_CHARS] + "\n\n[... diff truncated ...]"
        truncated = True

    system_prompt = load_prompt()

    context_block = ""
    if repo_fingerprint:
        # Heading + separator make the boundary unambiguous to the model.
        # We deliberately put the context BEFORE the PR metadata so the
        # reviewer reads "what is this repo" before "what's in this diff".
        context_block = (
            "REPOSITORY CONTEXT:\n"
            f"{repo_fingerprint}\n"
            "\n---\n\n"
        )

    user_msg = f"""{context_block}PR DIFF:
PR title: {pr['title']}
PR description: {pr.get('body') or '(none)'}
Author: {pr['user']['login']}
Base branch: {pr['base']['ref']}
Files changed: {pr.get('changed_files', 'unknown')}
Additions: +{pr.get('additions', '?')} / Deletions: -{pr.get('deletions', '?')}

Unified diff:
```diff
{diff}
```

Respond ONLY with valid JSON matching this schema (no markdown fences, no prose before or after):
{{
  "summary": "1-2 sentence summary of what the PR does AND overall quality",
  "verdict": "approve" | "request_changes" | "comment",
  "confidence": "high" | "medium" | "low",
  "severity_score": 1-10 integer (see prompt rubric — 9+ triggers auto-close, be conservative),
  "bugs": [
    {{
      "file": "exact path from the diff, or \\"multiple files\\"",
      "line_hint": "42" | "42-58" | null,
      "severity": "critical" | "high" | "medium" | "low",
      "issue": "one sentence: what is wrong",
      "impact": "one sentence: what could go wrong if unfixed",
      "suggestion": "concrete fix (prose, or a fenced code snippet of <=10 lines)",
      "reference": "URL to a doc/RFC/CVE/spec if you can cite one accurately, else null"
    }}
  ],
  "concerns": [
    {{
      "file": "path or \\"multiple files\\"",
      "line_hint": "42" | "42-58" | null,
      "severity": "low" | "medium",
      "issue": "non-bug concern: style, naming, testing gap, etc.",
      "impact": "why this concern matters in one sentence",
      "suggestion": "concrete improvement",
      "reference": null
    }}
  ],
  "questions": ["questions you'd ask the author if you were unsure"],
  "praise": ["specific things done well — leave empty if nothing stands out"]
}}

The prompt.md `Output format` section spells out every field's exact content requirements — follow them. If a field doesn't apply (e.g. no good doc to reference), use `null`, not a made-up value."""

    response = client.messages.create(
        model=model,
        max_tokens=2000,
        system=system_prompt,
        messages=[{"role": "user", "content": user_msg}],
    )

    text = response.content[0].text.strip()
    # Strip the OUTERMOST code fence if Claude wraps its JSON despite
    # instructions. Important: Phase 3's schema explicitly invites Claude
    # to embed fenced code blocks inside `suggestion` string values, so we
    # cannot naively `split("```")` — that would chop the response in half
    # at the first inner fence and leave us with an unterminated string.
    # Instead: drop only the opening fence line (e.g. ```json\n or ```\n)
    # and the trailing fence, leaving inner fences inside string values
    # untouched.
    if text.startswith("```"):
        first_nl = text.find("\n")
        text = text[first_nl + 1:] if first_nl != -1 else text[3:]
        text = text.rstrip()
        if text.endswith("```"):
            text = text[:-3].rstrip()

    parsed = json.loads(text)
    parsed["_truncated"] = truncated
    parsed["_input_tokens"] = response.usage.input_tokens
    parsed["_output_tokens"] = response.usage.output_tokens
    return parsed


# --- Formatting -----------------------------------------------------------

VERDICT_EMOJI = {"approve": "✅", "request_changes": "🔴", "comment": "💬"}

# Human-friendly labels used in the rich Phase-3 comment header.
VERDICT_LABEL = {
    "approve": "APPROVE",
    "request_changes": "REQUEST CHANGES",
    "comment": "COMMENT",
}

# Human-friendly text for the "Repo context" footer line (Phase 3).
FINGERPRINT_STATUS_LABEL = {
    "cached":      "cached",
    "fresh":       "fresh",
    "unavailable": "unavailable",
}


def compute_cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    """Convert token counts to a USD cost using MODEL_PRICING_USD_PER_M_TOKENS.

    Returns 0.0 if the model isn't in the pricing table — better to render
    "$0.000" than to crash the comment formatter on an unknown model string.
    Callers that need precise accounting (benchmark.py) have their own
    micro-USD computation in integer units."""
    rates = MODEL_PRICING_USD_PER_M_TOKENS.get(model)
    if not rates:
        return 0.0
    return (
        (input_tokens or 0) * rates["input"]
        + (output_tokens or 0) * rates["output"]
    ) / 1_000_000.0


def _format_cost(cost_usd: float) -> str:
    """Format a USD cost for the comment footer. Three decimal places so
    sub-cent reviews render as e.g. `$0.008` instead of vanishing to `$0.00`."""
    return f"${cost_usd:.3f}"


def _bug_location(bug: dict) -> str:
    """Render `file:line` (or just `file`) for the bug heading."""
    file_ = bug.get("file") or "?"
    line = bug.get("line_hint")
    if line in (None, "", "null"):
        return f"`{file_}`"
    return f"`{file_}:{line}`"


def _render_bug_section(bugs: list[dict]) -> list[str]:
    """Build the markdown lines for the 🐛 Bugs section in severity order."""
    if not bugs:
        return []

    # Group by severity so the comment is severity-sorted, not arbitrary.
    by_sev: dict[str, list[dict]] = {s: [] for s in SEVERITY_ORDER}
    extras: list[dict] = []  # anything with a severity we don't recognize
    for b in bugs:
        sev = (b.get("severity") or "").lower()
        if sev in by_sev:
            by_sev[sev].append(b)
        else:
            extras.append(b)

    lines = [f"### 🐛 Bugs ({len(bugs)})", ""]
    rendered_any = False
    for sev in SEVERITY_ORDER:
        for b in by_sev[sev]:
            rendered_any = True
            emoji = SEVERITY_EMOJI.get(sev, "•")
            issue = (b.get("issue") or "").strip()
            lines.append(f"#### {emoji} {issue} — {_bug_location(b)}")
            lines.append("")
            impact = (b.get("impact") or "").strip()
            if impact:
                lines.append(f"**Impact:** {impact}")
                lines.append("")
            suggestion = (b.get("suggestion") or "").strip()
            if suggestion:
                lines.append("**Suggested fix:**")
                lines.append("")
                # If the suggestion already contains a fenced block, render
                # it verbatim. Otherwise treat it as prose and bullet it.
                if "```" in suggestion:
                    lines.append(suggestion)
                else:
                    lines.append(suggestion)
                lines.append("")
            reference = (b.get("reference") or "").strip()
            if reference and reference.lower() != "null":
                lines.append(f"_Reference:_ {reference}")
                lines.append("")
            lines.append("---")
            lines.append("")
    for b in extras:
        # Render unknown-severity bugs at the end without a leading emoji so
        # the comment never silently drops a bug just because severity was
        # mis-cased or hallucinated.
        rendered_any = True
        issue = (b.get("issue") or "").strip()
        lines.append(f"#### • {issue} — {_bug_location(b)}")
        lines.append("")
        lines.append("---")
        lines.append("")

    if not rendered_any:
        # Defensive — shouldn't hit unless `bugs` was a list of empty dicts.
        return []
    return lines


def _render_concerns_section(concerns: list) -> list[str]:
    """Concerns may be plain strings (legacy / fallback) or dicts shaped like
    bugs. Render both. Heading shows the count."""
    if not concerns:
        return []
    lines = [f"### ⚠️ Concerns ({len(concerns)})", ""]
    for c in concerns:
        if isinstance(c, dict):
            issue = (c.get("issue") or "").strip()
            location = _bug_location(c) if c.get("file") else ""
            sev = (c.get("severity") or "").lower()
            sev_tag = f" _[{sev}]_" if sev in SEVERITY_EMOJI else ""
            head = f"- {issue}"
            if location:
                head += f" — {location}"
            if sev_tag:
                head += sev_tag
            lines.append(head)
            impact = (c.get("impact") or "").strip()
            if impact:
                lines.append(f"  - **Impact:** {impact}")
            suggestion = (c.get("suggestion") or "").strip()
            if suggestion:
                lines.append(f"  - **Suggestion:** {suggestion}")
        else:
            lines.append(f"- {c}")
    lines.append("")
    return lines


def _render_simple_list_section(heading: str, items: list) -> list[str]:
    """For `questions` and `praise` — plain-string lists."""
    if not items:
        return []
    lines = [f"{heading} ({len(items)})", ""]
    lines.extend(f"- {x}" for x in items)
    lines.append("")
    return lines


def format_close_comment(review: dict, review_url: str | None = None) -> str:
    """Format the comment posted alongside an auto-close action."""
    bug_lines = []
    for b in review.get("bugs", []):
        sev = b.get("severity", "?").upper()
        bug_lines.append(f"- **[{sev}]** `{b.get('file', '?')}` — {b['issue']}")

    lines = [
        CLOSE_MARKER,
        "## 🚫 PR auto-closed by Lyncas",
        "",
        f"This PR was automatically closed because all three gates were met:",
        f"- Verdict: `request_changes`",
        f"- Confidence: `high`",
        f"- Severity score: **{review.get('severity_score', '?')}/10** (threshold: {AUTO_CLOSE_MIN_SEVERITY})",
        "",
        "### Why",
        review["summary"],
        "",
    ]

    if bug_lines:
        lines.append("### Issues flagged")
        lines.extend(bug_lines)
        lines.append("")

    lines += [
        "### Disagree?",
        "**If you believe this close is wrong, reopen the PR with the `Reopen pull request` button at the bottom.** The agent will not close it again (it leaves a marker). The repo owner will review the dispute in the morning digest.",
        "",
        "### Recommended path forward",
        "1. Address the issues listed above in a new commit on the same branch",
        "2. Open a fresh PR",
        "",
        "---",
        "*This action was automated. LLMs can be wrong. The repo owner audits every auto-close in the daily digest.*",
    ]
    return "\n".join(lines)


def format_review_comment(review: dict) -> str:
    """Format Claude's review as a rich markdown PR comment (Phase 3 layout).

    Reads optional metadata from the review dict so the caller doesn't have
    to plumb extra args through:
      - ``_fingerprint_status``: ``"cached"`` / ``"fresh"`` / ``"unavailable"``
      - ``_model``: model string used for the review (for the footer + cost)
      - ``_input_tokens`` / ``_output_tokens``: from review_pr_with_claude
      - ``_truncated``: True if the diff was truncated

    All metadata fields are optional — the formatter falls back to safe
    defaults so a stripped-down review dict (e.g. from a unit test) still
    renders."""
    verdict = review.get("verdict", "")
    confidence = review.get("confidence", "")
    severity_score = review.get("severity_score", "?")
    verdict_emoji = VERDICT_EMOJI.get(verdict, "🤖")
    verdict_label = VERDICT_LABEL.get(verdict, verdict.upper() or "REVIEW")

    bugs = review.get("bugs") or []
    concerns = review.get("concerns") or []
    questions = review.get("questions") or []
    praise = review.get("praise") or []

    lines: list[str] = [
        REVIEW_MARKER,
        "## 🌙 Lyncas",
        "",
        f"**Verdict:** {verdict_emoji} {verdict_label}  ",
        f"**Severity:** {severity_score}/10 · **Confidence:** {confidence}",
        "",
        f"> {review.get('summary', '').strip()}",
        "",
        "---",
        "",
    ]

    bug_lines = _render_bug_section(bugs)
    if bug_lines:
        lines.extend(bug_lines)
    else:
        # Show an explicit "(0)" so the reviewer's structure is consistent
        # across PRs and the reader doesn't wonder if a section got dropped.
        lines.append("### 🐛 Bugs (0)")
        lines.append("")
        lines.append("_No bugs flagged._")
        lines.append("")
        lines.append("---")
        lines.append("")

    lines.extend(_render_concerns_section(concerns))
    lines.extend(_render_simple_list_section("### ❓ Questions", questions))
    lines.extend(_render_simple_list_section("### ✅ Praise", praise))

    if review.get("_truncated"):
        lines.append(
            "> ⚠️ Diff was truncated due to size. Review is based on the first portion only."
        )
        lines.append("")

    # ---- Footer: model, tokens, cost, repo-context status -----------------
    model = review.get("_model") or MODEL
    in_tok = review.get("_input_tokens") or 0
    out_tok = review.get("_output_tokens") or 0
    cost = compute_cost_usd(model, in_tok, out_tok)
    fp_status = review.get("_fingerprint_status") or "unavailable"
    fp_label = FINGERPRINT_STATUS_LABEL.get(fp_status, fp_status)

    lines.append("---")
    lines.append(
        f"*Reviewed by `{model}` · {in_tok} in / {out_tok} out · {_format_cost(cost)}*"
    )
    lines.append(f"*Repo context: {fp_label}*")
    return "\n".join(lines)


# --- Main loop ------------------------------------------------------------

def main() -> int:
    print(f"[startup] Using model: {MODEL}")

    # Webhook-triggered runs (agent/webhook_handler.py) set PR_FILTER_REPO
    # + PR_FILTER_NUMBER to scope this invocation to a single PR. The cron
    # path leaves both unset and continues to scan every repo in REPOS.
    # Both must be set for the filter to take effect — a half-configured
    # filter falls back to a full scan with a warning so we never silently
    # mis-interpret operator intent.
    filter_repo = os.environ.get("PR_FILTER_REPO") or None
    filter_pr_raw = os.environ.get("PR_FILTER_NUMBER")
    filter_pr_number: int | None = None
    if filter_repo and filter_pr_raw:
        try:
            filter_pr_number = int(filter_pr_raw)
        except ValueError:
            print(
                f"[startup] PR_FILTER_NUMBER={filter_pr_raw!r} is not an int; "
                "ignoring filter and scanning all repos",
                file=sys.stderr,
            )
            filter_repo = None
    elif filter_repo or filter_pr_raw:
        print(
            f"[startup] PR_FILTER_REPO={filter_repo!r} / "
            f"PR_FILTER_NUMBER={filter_pr_raw!r} is half-set; "
            "ignoring filter and scanning all repos",
            file=sys.stderr,
        )
        filter_repo = None

    filter_active = bool(filter_repo and filter_pr_number is not None)

    # Source-of-truth resolution for what to scan + which token to use:
    #
    #   1. REPOS env var set → legacy single-tenant mode. Every repo uses
    #      the module-level GITHUB_TOKEN. No user_id stamping (user_id stays
    #      NULL on review rows, which the dashboard's user-scoped views
    #      explicitly include).
    #   2. REPOS unset → SaaS mode. Query watched_repos for enabled rows;
    #      each row carries its own credential (PAT or installation token)
    #      and user_id. Empty result falls through to REPOS (which is also
    #      empty) for a clean no-op run.
    #
    # The webhook path (PR_FILTER_REPO/NUMBER) wraps either source —
    # if the filtered repo is in watched_repos we use the per-row
    # credential; otherwise we fall back to GITHUB_TOKEN.
    watched_index: dict[str, dict] = {}
    if not REPOS:
        for row in get_watched_repos():
            r = (row.get("repo") or "").strip()
            if r:
                watched_index[r] = row
        if watched_index:
            print(
                f"[startup] multi-tenant mode: {len(watched_index)} watched "
                f"repo(s) from Supabase"
            )

    if filter_active:
        scan_specs: list[tuple[str, str, str | None]] = []
        row = watched_index.get(filter_repo)  # type: ignore[arg-type]
        token = resolve_repo_token(row) if row else GITHUB_TOKEN
        user_id = row.get("user_id") if row else None
        scan_specs.append((filter_repo, token, user_id))  # type: ignore[arg-type]
        print(
            f"[startup] filter active: reviewing only "
            f"{filter_repo}#{filter_pr_number}"
        )
    elif REPOS:
        scan_specs = [(r, GITHUB_TOKEN, None) for r in REPOS]
    else:
        scan_specs = [
            (r, resolve_repo_token(row), row.get("user_id"))
            for r, row in watched_index.items()
        ]

    repos_to_scan = [s[0] for s in scan_specs]
    run_id = insert_run(repos_to_scan)
    reviewed_count = 0          # PRs the agent acted on via GitHub this run
    reviews_created = 0         # rows successfully written to `reviews` table
    skipped = 0
    errors: list[dict] = []

    for repo, repo_token, repo_user_id in scan_specs:
        # Phase 9: dashboard-configured per-repo rules. Loaded once per
        # repo per run; the same dict is reused for every PR in this
        # repo so we don't pay a Supabase round-trip per PR.
        repo_rules = get_repo_rules(repo)
        if not repo_rules.get("enabled", True):
            print(f"[{repo}] skipped (disabled via dashboard)")
            skipped += 1
            continue

        if not repo_token:
            print(
                f"[{repo}] no GitHub token resolved (watched_repos row has "
                f"no PAT / installation, and GITHUB_TOKEN_PAT is unset); "
                f"skipping",
                file=sys.stderr,
            )
            errors.append({"repo": repo, "error": "no_github_token"})
            continue

        try:
            if filter_active:
                prs = [get_pr(repo, filter_pr_number, token=repo_token)]  # type: ignore[arg-type]
            else:
                prs = list_open_prs(repo, token=repo_token)
        except Exception as e:
            print(f"[ERROR] Could not list PRs for {repo}: {e}", file=sys.stderr)
            errors.append({"repo": repo, "error": str(e)})
            continue

        print(f"[{repo}] {len(prs)} open PR(s)")

        # Fetch the repo fingerprint once per repo, regardless of how many
        # PRs we end up reviewing. Cache hits are free; cache misses do one
        # shallow clone + one Claude summarizer call. On any failure this
        # returns (None, "unavailable") and the per-PR review proceeds
        # without repo context.
        if prs:
            repo_fingerprint, fingerprint_status = get_or_refresh_fingerprint(
                repo, token=repo_token
            )
        else:
            repo_fingerprint, fingerprint_status = None, "unavailable"

        for pr in prs:
            num = pr["number"]
            tag = f"{repo}#{num}"

            try:
                if already_reviewed(repo, num, token=repo_token):
                    print(f"  [{tag}] already reviewed, skipping")
                    skipped += 1
                    continue

                print(f"  [{tag}] fetching diff...")
                diff = get_pr_diff(repo, num, token=repo_token)

                # Phase 9: apply path filters before doing any review work.
                # File list comes from the diff itself rather than a separate
                # /files API call so the filter sees exactly what the
                # reviewer would see.
                pr_files = _extract_files_from_diff(diff)
                watch_paths = repo_rules.get("watch_paths") or []
                skip_paths = repo_rules.get("skip_paths") or []

                if skip_paths and pr_files and all(
                    _path_matches_any(f, skip_paths) for f in pr_files
                ):
                    print(
                        f"  [{tag}] skipped (only touches skip_paths: "
                        f"{', '.join(pr_files[:3])}"
                        f"{'...' if len(pr_files) > 3 else ''})"
                    )
                    skipped += 1
                    continue

                if watch_paths and pr_files and not any(
                    _path_matches_any(f, watch_paths) for f in pr_files
                ):
                    print(f"  [{tag}] skipped (no watched paths)")
                    skipped += 1
                    continue

                # Persist the observed directory layout so /settings can
                # render it as a read-only tree. Cheap (one upsert) and
                # best-effort — failures don't block the review.
                if pr_files:
                    upsert_repo_directory_tree(
                        repo, _directory_tree_from_files(pr_files)
                    )

                # Inject operator rules into the prompt by prepending an
                # OPERATOR RULES block to the diff string. Living inside
                # the ```diff fence is intentional — that's the place
                # in the prompt the reviewer is told to read most
                # carefully, and the OPERATOR RULES: header + ---
                # separator are unambiguous to the model.
                operator_block = _build_operator_rules_block(repo_rules)
                if operator_block:
                    print(
                        f"  [{tag}] applying operator rules "
                        f"({len(operator_block)} chars)"
                    )
                diff_for_review = operator_block + diff

                print(f"  [{tag}] running LangGraph review (reviewer → critic → router → ...)...")
                review = run_review_graph(
                    pr, diff_for_review, repo_fingerprint=repo_fingerprint
                )
                # Stamp the review dict with metadata the rich formatter and
                # the Supabase upsert both rely on. Keeping it on the dict
                # (rather than threading more args through) matches the
                # pattern already used for _input_tokens / _output_tokens.
                # _critic_output / _arbiter_output / _escalated are set by
                # run_review_graph itself — we do not overwrite them here.
                review["_fingerprint_status"] = fingerprint_status
                review["_model"] = MODEL

                # Decide: post comment, or auto-close. Per-repo rules
                # (auto_close_all + threshold override) participate here;
                # see should_auto_close docstring.
                close_decision, gate_reason = should_auto_close(
                    review, rules=repo_rules
                )

                action = "commented"
                if close_decision:
                    print(f"  [{tag}] 🚫 ALL GATES PASSED → auto-closing "
                          f"(severity={review['severity_score']}, verdict={review['verdict']}, "
                          f"confidence={review['confidence']})")
                    close_comment = format_close_comment(review)
                    close_pr(repo, num, close_comment, token=repo_token)
                    action = "closed"
                else:
                    comment = format_review_comment(review)
                    post_review_comment(repo, num, comment, token=repo_token)
                    print(f"  [{tag}] ✅ posted ({review['verdict']}, {review['confidence']} "
                          f"confidence, severity {review.get('severity_score', '?')}) "
                          f"— close gates not met: {gate_reason}")

                reviewed_count += 1

                # GitHub side is done. Persist to Supabase; soft-fail so a DB
                # outage doesn't bury the comment we already posted.
                try:
                    upsert_review(
                        pr=pr,
                        repo=repo,
                        review=review,
                        action=action,
                        gate_reason=gate_reason,
                        user_id=repo_user_id,
                    )
                    reviews_created += 1
                except Exception as db_e:
                    print(
                        f"  [{tag}] ⚠️  Supabase upsert failed: {db_e}",
                        file=sys.stderr,
                    )
                    errors.append({"pr": tag, "error": f"supabase_upsert: {db_e}"})
            except Exception as e:
                print(f"  [{tag}] ❌ error: {e}", file=sys.stderr)
                errors.append({"pr": tag, "error": str(e)})

    finalize_run(run_id, reviews_created, skipped, errors)
    print(
        f"\nSummary: {reviewed_count} reviewed on GitHub, "
        f"{reviews_created} persisted to Supabase, "
        f"{skipped} skipped, {len(errors)} errored "
        f"(run_id={run_id})"
    )

    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
