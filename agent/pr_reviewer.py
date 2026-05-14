"""
Night PR Reviewer — autonomous agent that reviews open PRs on configured repos
using Claude, posts the review as a PR comment, and logs work for a daily digest.

Runs hourly via GitHub Actions. Idempotent — won't re-review the same PR.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from anthropic import Anthropic
from supabase import Client, create_client

# --- Config ---------------------------------------------------------------

ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
GITHUB_TOKEN = os.environ["GITHUB_TOKEN_PAT"]  # personal PAT, not the default GITHUB_TOKEN
REPOS = [r.strip() for r in os.environ.get("REPOS", "").split(",") if r.strip()]  # e.g. "user/repo1,user/repo2"

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
GH_HEADERS = {
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

client = Anthropic(api_key=ANTHROPIC_API_KEY)


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


def insert_run() -> str | None:
    """Insert a fresh row into `runs` and return its id (None on failure)."""
    if supabase is None:
        return None
    try:
        resp = (
            supabase.table("runs")
            .insert(
                {
                    "trigger_source": os.environ.get("GITHUB_EVENT_NAME", "unknown"),
                    "repos_scanned": REPOS,
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
) -> None:
    """Upsert one row in `reviews`. Re-reviews of the same (repo, pr_number)
    overwrite cleanly via the unique index. Raises on failure — the caller
    decides how to handle (the GitHub comment has already been posted)."""
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
    }
    supabase.table("reviews").upsert(payload, on_conflict="repo,pr_number").execute()


# --- GitHub helpers -------------------------------------------------------

def list_open_prs(repo: str) -> list[dict]:
    """Return list of open PRs (excluding drafts) for a repo."""
    r = requests.get(
        f"{GITHUB_API}/repos/{repo}/pulls",
        headers=GH_HEADERS,
        params={"state": "open", "per_page": 30},
        timeout=30,
    )
    r.raise_for_status()
    return [pr for pr in r.json() if not pr.get("draft")]


def already_reviewed(repo: str, pr_number: int) -> bool:
    """Check if we've already touched this PR (review or close marker)."""
    r = requests.get(
        f"{GITHUB_API}/repos/{repo}/issues/{pr_number}/comments",
        headers=GH_HEADERS,
        params={"per_page": 100},
        timeout=30,
    )
    r.raise_for_status()
    return any(
        REVIEW_MARKER in c.get("body", "") or CLOSE_MARKER in c.get("body", "")
        for c in r.json()
    )


def get_pr_diff(repo: str, pr_number: int) -> str:
    """Fetch the raw unified diff for a PR."""
    r = requests.get(
        f"{GITHUB_API}/repos/{repo}/pulls/{pr_number}",
        headers={**GH_HEADERS, "Accept": "application/vnd.github.v3.diff"},
        timeout=30,
    )
    r.raise_for_status()
    return r.text


def post_review_comment(repo: str, pr_number: int, body: str) -> None:
    """Post the review as a regular PR comment."""
    r = requests.post(
        f"{GITHUB_API}/repos/{repo}/issues/{pr_number}/comments",
        headers=GH_HEADERS,
        json={"body": body},
        timeout=30,
    )
    r.raise_for_status()


def close_pr(repo: str, pr_number: int, reason_comment: str) -> None:
    """Post a reason comment, then close the PR. Order matters — comment first
    so the author sees the explanation when they get the close notification."""
    post_review_comment(repo, pr_number, reason_comment)
    r = requests.patch(
        f"{GITHUB_API}/repos/{repo}/pulls/{pr_number}",
        headers=GH_HEADERS,
        json={"state": "closed"},
        timeout=30,
    )
    r.raise_for_status()


def should_auto_close(review: dict) -> tuple[bool, str]:
    """Apply the three-gate check. Returns (should_close, reason_if_not)."""
    if not ALLOW_AUTO_CLOSE:
        return False, "ALLOW_AUTO_CLOSE is false (default)"

    score = review.get("severity_score", 0)
    verdict = review.get("verdict", "")
    confidence = review.get("confidence", "")

    failed = []
    if verdict != AUTO_CLOSE_REQUIRED_VERDICT:
        failed.append(f"verdict={verdict} (need {AUTO_CLOSE_REQUIRED_VERDICT})")
    if confidence != AUTO_CLOSE_REQUIRED_CONFIDENCE:
        failed.append(f"confidence={confidence} (need {AUTO_CLOSE_REQUIRED_CONFIDENCE})")
    if not isinstance(score, int) or score < AUTO_CLOSE_MIN_SEVERITY:
        failed.append(f"severity={score} (need >= {AUTO_CLOSE_MIN_SEVERITY})")

    if failed:
        return False, "; ".join(failed)
    return True, ""


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


def get_or_refresh_fingerprint(repo: str) -> tuple[str | None, str]:
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

    if not GITHUB_TOKEN:
        print(
            f"  [fingerprint:{repo}] no GITHUB_TOKEN_PAT — cannot clone, "
            f"proceeding without repo context",
            file=sys.stderr,
        )
        return None, "unavailable"

    slug = repo.replace("/", "-")
    clone_dir = Path(tempfile.mkdtemp(prefix=f"fp-{slug}-"))

    try:
        # x-access-token is the documented basic-auth username for PAT-auth
        # clones; the PAT itself is the password. This works for both
        # classic and fine-grained PATs scoped to the target repo.
        clone_url = f"https://x-access-token:{GITHUB_TOKEN}@github.com/{repo}.git"
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
    # Strip accidental code fences if Claude adds them despite instructions
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()

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
        "## 🚫 PR auto-closed by night-pr-reviewer",
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
        "## 🌙 Night PR Reviewer",
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
    run_id = insert_run()
    reviewed_count = 0          # PRs the agent acted on via GitHub this run
    reviews_created = 0         # rows successfully written to `reviews` table
    skipped = 0
    errors: list[dict] = []

    for repo in REPOS:
        try:
            prs = list_open_prs(repo)
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
            repo_fingerprint, fingerprint_status = get_or_refresh_fingerprint(repo)
        else:
            repo_fingerprint, fingerprint_status = None, "unavailable"

        for pr in prs:
            num = pr["number"]
            tag = f"{repo}#{num}"

            try:
                if already_reviewed(repo, num):
                    print(f"  [{tag}] already reviewed, skipping")
                    skipped += 1
                    continue

                print(f"  [{tag}] fetching diff...")
                diff = get_pr_diff(repo, num)

                print(f"  [{tag}] asking Claude for review...")
                review = review_pr_with_claude(
                    pr, diff, repo_fingerprint=repo_fingerprint
                )
                # Stamp the review dict with metadata the rich formatter and
                # the Supabase upsert both rely on. Keeping it on the dict
                # (rather than threading more args through) matches the
                # pattern already used for _input_tokens / _output_tokens.
                review["_fingerprint_status"] = fingerprint_status
                review["_model"] = MODEL

                # Decide: post comment, or auto-close
                close_decision, gate_reason = should_auto_close(review)

                action = "commented"
                if close_decision:
                    print(f"  [{tag}] 🚫 ALL GATES PASSED → auto-closing "
                          f"(severity={review['severity_score']}, verdict={review['verdict']}, "
                          f"confidence={review['confidence']})")
                    close_comment = format_close_comment(review)
                    close_pr(repo, num, close_comment)
                    action = "closed"
                else:
                    comment = format_review_comment(review)
                    post_review_comment(repo, num, comment)
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
