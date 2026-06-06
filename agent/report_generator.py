#!/usr/bin/env python3
"""
report_generator.py — PR analysis report layer.

Spawned by agent/webhook_handler.py ~45 seconds after the reviewer
(pr_reviewer.py) and the sandbox (devpod_tester.py) start. The 45s
delay is a "head-start" lattice: by the time we boot, the reviewer
has typically already written its row in `reviews`, and the
sandbox is at least past clone/install. wait_for_data() handles
the rest by polling each table with bounded retries.

Pipeline:
  1. wait_for_data("reviews",  ...)  up to 120s
  2. wait_for_data("pr_sandbox_results", ...) up to 180s
     (longer because the sandbox is slow — build can take 120s alone)
  3. Call Claude Sonnet (NOT Opus — cost; the heavy review pass
     already paid the Opus toll) with a structured prompt asking
     for { what_it_adds, use_case, vision_alignment,
     merge_recommendation, ... }.
  4. Upsert into `pr_reports` on (repo, pr_number).
  5. Post a compact GitHub comment summarizing the recommendation +
     preview URL + a link back to the dashboard for the full report.

Backward-compat / fail-soft contract (mirrors devpod_tester.py):
  * Missing PR_FILTER_REPO/NUMBER  -> exit 0 with a one-line log.
  * Missing ANTHROPIC_API_KEY      -> exit 0.
  * Missing SUPABASE_URL/KEY       -> exit 0.
  * Claude call fails              -> upsert a fallback row built
    from the review + sandbox data we already have.
  * GitHub POST fails              -> log to stderr, keep going.
    The dashboard surfaces the report regardless.

The script is intentionally self-contained: no imports from
pr_reviewer / review_graph / send_digest. Those modules pull in
LangGraph and other heavy deps; this one only needs anthropic +
supabase + the stdlib. Keeps the 45s spawn cheap.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

# Same .env loading pattern as devpod_tester.py / pr_reviewer.py.
# A bare `import dotenv` failure is non-fatal: production runs on
# EC2 / GitHub Actions where env vars are injected externally and
# python-dotenv isn't necessarily present.
try:
    from dotenv import load_dotenv  # type: ignore[import-not-found]
    load_dotenv(Path(__file__).parent / ".env", override=True)
except ImportError:
    pass

from anthropic import Anthropic  # type: ignore[import-not-found]
from supabase import create_client  # type: ignore[import-not-found]


# --- Config --------------------------------------------------------------

REPO = os.environ.get("PR_FILTER_REPO", "")
PR_NUMBER_STR = os.environ.get("PR_FILTER_NUMBER", "0")
GITHUB_TOKEN = (
    os.environ.get("GITHUB_TOKEN")
    or os.environ.get("GITHUB_TOKEN_PAT", "")
)
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")

# Sonnet, not Opus. Mirror agent/pr_reviewer.py's MODEL_PRICING table:
# Sonnet is $3/$15 per 1M tokens vs Opus's $15/$75 — 5x cheaper on
# input, 5x cheaper on output. The reports run every PR; the cost
# delta dominates the latency delta here.
MODEL = "claude-sonnet-4-5"

# Max-token caps for the Claude call. 2000 fits a ~6KB markdown
# body plus the structured JSON fields comfortably; we've checked
# typical report bodies are 1.5-3KB.
MAX_TOKENS = 2000

# How long we'll poll Supabase before giving up. The reviewer
# typically lands in <60s on a webhook-triggered run, so 120s
# is a generous floor with one retry's worth of headroom. The
# sandbox is slower (install + tests + 180s build cap) so we
# give it more rope.
REVIEW_WAIT_SEC = 120
SANDBOX_WAIT_SEC = 180

# Poll interval — coarser than devpod_tester's because we're
# waiting on the entire reviewer/sandbox to finish, not a
# sub-step. 5s keeps the load on Supabase trivially light.
POLL_INTERVAL_SEC = 5

# GitHub comment marker — same convention as the reviewer's
# `<!-- night-pr-reviewer:v1 -->` and the sandbox's
# `<!-- night-pr-reviewer:sandbox:v2 -->`. Lets the next run
# update-in-place instead of stacking duplicate comments.
REPORT_COMMENT_MARKER = "<!-- night-pr-reviewer:report:v1 -->"

# Maximum bugs to include in the prompt's BUGS section. The full
# review_bugs payload still goes to Supabase; this just bounds the
# prompt size so a 50-bug PR doesn't balloon the token bill.
BUGS_IN_PROMPT = 5


# --- Supabase polling ----------------------------------------------------

def wait_for_data(
    supabase,
    table: str,
    repo: str,
    pr_number: int,
    max_wait: int,
) -> dict | None:
    """Poll `table` for a row matching (repo, pr_number) up to
    max_wait seconds. Returns the row dict on hit, None on timeout.

    Why poll instead of subscribe: Supabase Realtime would be the
    "right" answer, but it requires an open websocket and a far
    larger dependency surface. Polling at 5s intervals across a
    120s window is 24 cheap HEAD-style requests, which is well
    under any plausible rate limit.

    Any per-attempt exception is swallowed so a transient DB blip
    doesn't abort the wait — we'd rather hit the timeout and write
    a degraded report than crash the whole spawn."""
    attempts = max(1, max_wait // POLL_INTERVAL_SEC)
    for _ in range(attempts):
        try:
            resp = (
                supabase.table(table)
                .select("*")
                .eq("repo", repo)
                .eq("pr_number", pr_number)
                .maybe_single()
                .execute()
            )
            if resp.data:
                return resp.data
        except Exception as e:
            # Quiet on retry; loud if we never recover (caller logs
            # the timeout). A noisy log on every poll would drown
            # the normal happy-path single-line output.
            print(
                f"[report] {table} poll error (will retry): "
                f"{type(e).__name__}: {e}",
                file=sys.stderr,
            )
        time.sleep(POLL_INTERVAL_SEC)
    return None


# --- GitHub helpers ------------------------------------------------------

def _gh_request(
    method: str,
    url: str,
    token: str,
    body: dict | None = None,
    timeout: int = 30,
) -> tuple[int, dict | list | None]:
    """Minimal urllib-based GitHub API client. Returns (status_code,
    parsed_json_or_None). Errors are swallowed and surfaced as
    status -1 — the caller decides whether to retry."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "lyncas-report",
    }
    req = urllib.request.Request(
        url, data=data, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            parsed = json.loads(raw) if raw else None
            return r.status, parsed
    except urllib.error.HTTPError as e:
        try:
            parsed = json.loads(e.read())
        except Exception:
            parsed = None
        return e.code, parsed
    except Exception as e:
        print(
            f"[report] GitHub {method} {url} failed: "
            f"{type(e).__name__}: {e}",
            file=sys.stderr,
        )
        return -1, None


def _existing_report_comment_id(
    repo: str, pr_number: int, token: str
) -> int | None:
    """Find an existing report comment (by marker) so we can update
    it in place. Returns the GitHub-side comment id, or None.

    Mirrors devpod_tester.py's _existing_sandbox_comment_id pattern.
    Same idempotency rationale: a re-spawned report (operator
    manually re-triggers webhook on the same PR) should overwrite,
    not pile up."""
    status, body = _gh_request(
        "GET",
        f"https://api.github.com/repos/{repo}/issues/{pr_number}/comments?per_page=100",
        token,
    )
    if status != 200 or not isinstance(body, list):
        return None
    for c in body:
        b = c.get("body") or ""
        if REPORT_COMMENT_MARKER in b:
            cid = c.get("id")
            if isinstance(cid, int):
                return cid
    return None


def post_github_comment(
    repo: str, pr_number: int, body: str, token: str
) -> None:
    """Post or update the report comment on the PR. Idempotent
    via REPORT_COMMENT_MARKER. Failures are logged but never
    raised — the dashboard is the canonical surface; GitHub is
    a convenience."""
    if not token:
        print("[report] no GITHUB_TOKEN — skipping GitHub comment")
        return
    existing_id = _existing_report_comment_id(repo, pr_number, token)
    if existing_id is not None:
        status, _ = _gh_request(
            "PATCH",
            f"https://api.github.com/repos/{repo}/issues/comments/{existing_id}",
            token,
            body={"body": body},
        )
        if status == 200:
            print(f"[report] updated GitHub comment id={existing_id}")
            return
        print(
            f"[report] PATCH comment failed status={status}, "
            f"falling back to fresh POST",
            file=sys.stderr,
        )
    status, _ = _gh_request(
        "POST",
        f"https://api.github.com/repos/{repo}/issues/{pr_number}/comments",
        token,
        body={"body": body},
    )
    if status not in (200, 201):
        print(
            f"[report] POST comment failed status={status}",
            file=sys.stderr,
        )
    else:
        print(f"[report] posted GitHub comment")


# --- Sandbox build-status inference --------------------------------------

# pr_sandbox_results (migration 015) doesn't carry a dedicated
# build_success column. devpod_tester.py instead prepends a one-line
# "Build: passed/failed/skipped" header to the test_output column
# before persisting. We parse that here so the report's
# sandbox_build_success accurately reflects what the sandbox saw.
_BUILD_HEADER = re.compile(
    r"^Build:\s*(passed|failed|skipped|not[_ ]run)", re.IGNORECASE
)


def infer_build_success(sandbox_row: dict | None) -> bool | None:
    """Best-effort build outcome:
      * True  if test_output starts with 'Build: passed'.
      * False if test_output starts with 'Build: failed'.
      * None  for skipped / not-run / unparseable / no sandbox row.

    Returning None rather than False on "skipped" matters: the
    dashboard's badge renders 'skipped' as a neutral grey, not a
    red 'failed', which is the right signal for PRs that don't have
    a build step at all (Python/Go without a build target)."""
    if not sandbox_row:
        return None
    text = sandbox_row.get("test_output") or ""
    if not text:
        return None
    m = _BUILD_HEADER.match(text.lstrip())
    if not m:
        return None
    outcome = m.group(1).lower().replace(" ", "_")
    if outcome == "passed":
        return True
    if outcome == "failed":
        return False
    return None  # skipped / not_run


# --- Claude prompt + parsing --------------------------------------------

def _strip_code_fence(text: str) -> str:
    """Strip a ```json ... ``` fence if Claude wrapped its response.
    The prompt asks for raw JSON, but models occasionally helpfully
    fence it anyway."""
    t = text.strip()
    if not t.startswith("```"):
        return t
    # Drop the opening fence (may be ```json or just ```).
    first_nl = t.find("\n")
    if first_nl == -1:
        return t
    inner = t[first_nl + 1 :]
    # Drop the trailing fence if present.
    end = inner.rfind("```")
    if end != -1:
        inner = inner[:end]
    return inner.strip()


def build_prompt(
    repo: str,
    pr_number: int,
    pr_title: str,
    pr_author: str,
    review: dict | None,
    sandbox: dict | None,
    build_success: bool | None,
) -> str:
    """Compose the Sonnet prompt. Mirrors the spec's structure but
    explicitly tells Claude to substitute its own field values into
    the report_markdown template, rather than copying the literal
    placeholder text. The fallback (below) handles the case where
    a model variant ignores the substitution instruction."""
    review_verdict = (review or {}).get("verdict", "unknown")
    review_severity = (review or {}).get("severity_score", 0) or 0
    review_summary = (
        (review or {}).get("summary") or "No review available"
    )
    review_bugs = (review or {}).get("bugs") or []

    sandbox_overall = (sandbox or {}).get("overall", "not_run") or "not_run"
    sandbox_app_url = (sandbox or {}).get("app_url") or ""
    sandbox_tests_passed = (sandbox or {}).get("tests_passed", 0) or 0
    sandbox_tests_failed = (sandbox or {}).get("tests_failed", 0) or 0

    bugs_lines: list[str] = []
    for b in review_bugs[:BUGS_IN_PROMPT]:
        if not isinstance(b, dict):
            continue
        sev = str(b.get("severity", "?")).upper()
        f = b.get("file", "?")
        issue = b.get("issue", "?")
        bugs_lines.append(f"- [{sev}] {f}: {issue}")
    bugs_text = "\n".join(bugs_lines) or "None found"

    if build_success is True:
        build_label = "Passed"
    elif build_success is False:
        build_label = "Failed"
    elif sandbox is None:
        build_label = "Not run"
    else:
        build_label = "Skipped"

    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    today_short = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # JSON-as-text template. We ask Claude to FILL IN the bracketed
    # placeholders with its own field values inside the markdown
    # body — same shape as the spec, but with an explicit instruction
    # on the line above so the substitution isn't ambiguous.
    return f"""Analyze this pull request and generate a structured report.

REPO: {repo}
PR #{pr_number}: {pr_title}
Author: {pr_author}
Date: {now_str}

CODE REVIEW:
- Verdict: {review_verdict} | Severity: {review_severity}/10
- Summary: {review_summary}
- Bugs:
{bugs_text}

SANDBOX:
- Overall: {sandbox_overall}
- Tests: {sandbox_tests_passed} passed, {sandbox_tests_failed} failed
- Build: {build_label}
- Preview: {sandbox_app_url or 'Not available'}

Respond with ONLY valid JSON (no surrounding prose, no code fences).
In the report_markdown field, replace each [bracketed_placeholder]
with the actual value you chose for the corresponding JSON field
above it. Do not leave any literal "[what_it_adds]" or
"[merge_recommendation]" placeholders in the markdown.

{{
  "what_it_adds": "2-3 sentences describing what this PR adds",
  "use_case": "1-2 sentences on the use case",
  "vision_alignment": "aligned|neutral|misaligned|unknown",
  "vision_reasoning": "1-2 sentences",
  "merge_recommendation": "merge|request_changes|reject|needs_review",
  "merge_confidence": "high|medium|low",
  "merge_reasoning": "2-3 sentences explaining the recommendation",
  "report_markdown": "# PR Analysis Report: {pr_title}\\n\\n**Repository:** {repo}\\n**PR:** #{pr_number} by {pr_author}\\n**Date:** {today_short}\\n\\n---\\n\\n## What This PR Adds\\n[what_it_adds]\\n\\n**Use Case:** [use_case]\\n\\n## Vision Alignment\\n**[vision_alignment]** — [vision_reasoning]\\n\\n## Code Review\\n**Verdict:** {review_verdict} | **Severity:** {review_severity}/10\\n\\n{review_summary}\\n\\n## Sandbox Results\\n| Step | Result |\\n|------|--------|\\n| Tests | {sandbox_tests_passed} passed, {sandbox_tests_failed} failed |\\n| Build | {build_label} |\\n| Preview | {sandbox_app_url or 'N/A'} |\\n\\n## Recommendation\\n**[merge_recommendation]** (Confidence: [merge_confidence])\\n\\n[merge_reasoning]\\n\\n---\\n*Generated by Lyncas*"
}}"""


def call_claude(
    client: Anthropic,
    prompt: str,
) -> dict | None:
    """Call Claude with the report prompt. Returns the parsed
    JSON dict, or None if the call/parse failed. The caller falls
    back to a deterministic minimal report in either case."""
    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text
        parsed = json.loads(_strip_code_fence(text))
        if isinstance(parsed, dict):
            return parsed
        print(
            f"[report] Claude returned non-dict JSON: {type(parsed).__name__}",
            file=sys.stderr,
        )
        return None
    except Exception as e:
        print(
            f"[report] Claude call failed: {type(e).__name__}: {e}",
            file=sys.stderr,
        )
        return None


def build_fallback_report(
    repo: str,
    pr_number: int,
    pr_title: str,
    pr_author: str,
    review_verdict: str,
    review_severity: int,
    review_summary: str,
    sandbox_overall: str,
    build_success: bool | None,
    sandbox_tests_passed: int,
    sandbox_tests_failed: int,
    sandbox_app_url: str,
) -> dict:
    """Deterministic minimal report used when the Claude call fails
    or returns unparseable JSON. Preserves enough info that the
    dashboard card is still meaningful: the review verdict + the
    sandbox outcome + a tiny markdown body."""
    today_short = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if build_success is True:
        build_label = "Passed"
    elif build_success is False:
        build_label = "Failed"
    else:
        build_label = "Not run"

    md = (
        f"# PR Report: {pr_title}\n\n"
        f"**Repository:** {repo}\n"
        f"**PR:** #{pr_number} by {pr_author}\n"
        f"**Date:** {today_short}\n\n"
        f"---\n\n"
        f"## Code Review\n"
        f"**Verdict:** {review_verdict} | **Severity:** {review_severity}/10\n\n"
        f"{review_summary}\n\n"
        f"## Sandbox\n"
        f"- Overall: {sandbox_overall}\n"
        f"- Tests: {sandbox_tests_passed} passed, {sandbox_tests_failed} failed\n"
        f"- Build: {build_label}\n"
        f"- Preview: {sandbox_app_url or 'N/A'}\n\n"
        f"---\n*Generated by Lyncas (fallback — model unavailable)*\n"
    )
    return {
        "what_it_adds": review_summary,
        "use_case": "Could not determine — model unavailable.",
        "vision_alignment": "unknown",
        "vision_reasoning": "Analysis unavailable (model call failed).",
        "merge_recommendation": "needs_review",
        "merge_confidence": "low",
        "merge_reasoning": (
            f"Falling back to a deterministic summary. "
            f"Review verdict: {review_verdict}; sandbox: {sandbox_overall}."
        ),
        "report_markdown": md,
    }


# --- Comment formatting --------------------------------------------------

REC_EMOJI = {
    "merge": "✅",
    "request_changes": "⚠️",
    "reject": "❌",
    "needs_review": "🔍",
}
ALIGN_EMOJI = {
    "aligned": "✅",
    "neutral": "⚪",
    "misaligned": "❌",
    "unknown": "❓",
}


def format_pr_comment(
    report: dict, sandbox_app_url: str
) -> str:
    """The compact GitHub-side comment. Full report lives on
    /dashboard/reports — this is just a teaser so reviewers don't
    have to leave GitHub to see the recommendation."""
    rec = report.get("merge_recommendation") or "needs_review"
    rec_label = rec.upper().replace("_", " ")
    rec_emo = REC_EMOJI.get(rec, "🔍")
    align = report.get("vision_alignment") or "unknown"
    align_emo = ALIGN_EMOJI.get(align, "❓")
    confidence = report.get("merge_confidence") or "medium"
    preview_line = (
        f"\n🔗 **[Live Preview]({sandbox_app_url})**\n"
        if sandbox_app_url
        else ""
    )

    return (
        f"{REPORT_COMMENT_MARKER}\n"
        f"## 📊 PR Analysis Report\n\n"
        f"{rec_emo} **{rec_label}** · Confidence: {confidence} · "
        f"{align_emo} Vision: {align}\n\n"
        f"### What this PR adds\n"
        f"{report.get('what_it_adds', '') or '_no summary_'}\n\n"
        f"### Recommendation\n"
        f"{report.get('merge_reasoning', '') or '_no rationale_'}\n"
        f"{preview_line}\n"
        f"---\n"
        f"*Full report available in Lyncas dashboard*"
    )


# --- Main ----------------------------------------------------------------

def main() -> int:
    """Self-contained entry point. Every guard below returns 0
    rather than raising — the webhook handler doesn't read this
    process's exit code, but a clean exit keeps systemd journals
    from showing a spurious failure on operator-intentional
    no-ops (env var missing, model down, etc.)."""
    if not REPO:
        print("[report] PR_FILTER_REPO not set — exiting")
        return 0
    try:
        pr_number = int(PR_NUMBER_STR)
    except ValueError:
        print(
            f"[report] PR_FILTER_NUMBER={PR_NUMBER_STR!r} not int — exiting",
            file=sys.stderr,
        )
        return 0
    if pr_number <= 0:
        print("[report] PR_FILTER_NUMBER missing/zero — exiting")
        return 0
    if not ANTHROPIC_API_KEY:
        print("[report] ANTHROPIC_API_KEY not set — exiting")
        return 0
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        print("[report] SUPABASE_URL/KEY not set — exiting")
        return 0

    print(f"[report] starting for {REPO}#{pr_number}")
    supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    client = Anthropic(api_key=ANTHROPIC_API_KEY)

    # Wait for the upstream signals. Reviewer first (faster),
    # sandbox second. Either may genuinely be absent — we handle
    # None below.
    review = wait_for_data(
        supabase, "reviews", REPO, pr_number, REVIEW_WAIT_SEC
    )
    if review is None:
        print(
            f"[report] no `reviews` row for {REPO}#{pr_number} "
            f"after {REVIEW_WAIT_SEC}s — proceeding with degraded report"
        )
    sandbox = wait_for_data(
        supabase, "pr_sandbox_results", REPO, pr_number, SANDBOX_WAIT_SEC
    )
    if sandbox is None:
        print(
            f"[report] no `pr_sandbox_results` row for {REPO}#{pr_number} "
            f"after {SANDBOX_WAIT_SEC}s — likely no DevPod session live; "
            f"proceeding without sandbox signal"
        )

    pr_title = (
        (review or {}).get("pr_title") or f"PR #{pr_number}"
    )
    pr_author = (review or {}).get("pr_author") or "unknown"
    review_verdict = (review or {}).get("verdict") or "unknown"
    review_severity = (review or {}).get("severity_score") or 0
    review_summary = (
        (review or {}).get("summary") or "No review available"
    )
    review_bugs = (review or {}).get("bugs") or []
    sandbox_overall = (sandbox or {}).get("overall") or "not_run"
    sandbox_app_url = (sandbox or {}).get("app_url") or ""
    sandbox_tests_passed = (sandbox or {}).get("tests_passed") or 0
    sandbox_tests_failed = (sandbox or {}).get("tests_failed") or 0
    build_success = infer_build_success(sandbox)
    user_id = (sandbox or {}).get("user_id") or None

    prompt = build_prompt(
        repo=REPO,
        pr_number=pr_number,
        pr_title=pr_title,
        pr_author=pr_author,
        review=review,
        sandbox=sandbox,
        build_success=build_success,
    )

    print(f"[report] calling Claude {MODEL}…")
    report = call_claude(client, prompt)
    if report is None:
        print("[report] using fallback report")
        report = build_fallback_report(
            repo=REPO,
            pr_number=pr_number,
            pr_title=pr_title,
            pr_author=pr_author,
            review_verdict=review_verdict,
            review_severity=review_severity,
            review_summary=review_summary,
            sandbox_overall=sandbox_overall,
            build_success=build_success,
            sandbox_tests_passed=sandbox_tests_passed,
            sandbox_tests_failed=sandbox_tests_failed,
            sandbox_app_url=sandbox_app_url,
        )

    # Persist. Soft-fail on DB error — the GitHub comment below
    # is still useful even if the row didn't land.
    try:
        supabase.table("pr_reports").upsert(
            {
                "repo": REPO,
                "pr_number": pr_number,
                "pr_title": pr_title,
                "pr_author": pr_author,
                "user_id": user_id,
                "what_it_adds": report.get("what_it_adds"),
                "use_case": report.get("use_case"),
                "vision_alignment": report.get("vision_alignment"),
                "vision_reasoning": report.get("vision_reasoning"),
                "review_verdict": review_verdict,
                "review_severity": review_severity,
                "review_bugs": review_bugs,
                "review_summary": review_summary,
                "sandbox_overall": sandbox_overall,
                "sandbox_tests_passed": sandbox_tests_passed,
                "sandbox_tests_failed": sandbox_tests_failed,
                "sandbox_build_success": build_success,
                "sandbox_app_url": sandbox_app_url,
                "merge_recommendation": report.get("merge_recommendation"),
                "merge_confidence": report.get("merge_confidence"),
                "merge_reasoning": report.get("merge_reasoning"),
                "report_markdown": report.get("report_markdown"),
            },
            on_conflict="repo,pr_number",
        ).execute()
        print(f"[report] stored in pr_reports")
    except Exception as e:
        print(
            f"[report] Supabase upsert failed: "
            f"{type(e).__name__}: {e}",
            file=sys.stderr,
        )

    if GITHUB_TOKEN:
        comment = format_pr_comment(report, sandbox_app_url)
        post_github_comment(REPO, pr_number, comment, GITHUB_TOKEN)
    else:
        print("[report] no GITHUB_TOKEN — skipping GitHub comment")

    print(
        f"[report] done — recommendation: "
        f"{report.get('merge_recommendation')}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
