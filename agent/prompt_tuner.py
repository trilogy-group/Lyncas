"""
prompt_tuner.py — Phase 8 prompt-tuner agent (separate scheduled script).

Once a week (or on manual workflow_dispatch), this script:

  1. Pulls every settled `false_close` and `missed_issue` row from
     `human_actions` over the last 30 days. These are the cases where
     the agent disagreed with the human and the human turned out right.
  2. Bundles each failure case with its review JSON and (a truncated
     copy of) the underlying PR diff fetched fresh from GitHub.
  3. Asks Claude to read those cases alongside the current `prompt.md`
     and propose a *new full* `prompt.md` aimed at preventing those
     specific failure modes — plus a short rationale and a rough
     accuracy-after estimate.
  4. Diffs the old and new prompt locally. If the diff is empty, exits
     without opening a PR.
  5. Opens a PR against the agent repo with the new `prompt.md`. The
     agent NEVER edits prompt.md directly and NEVER merges its own PR.
     A human reviews every prompt change.
  6. Persists the run to Supabase `prompt_tuner_runs` so the /learning
     dashboard can list pending prompt improvements.

It also refreshes the `status` field on previously-open prompt_tuner_runs
rows by polling the corresponding GitHub PRs, so the dashboard's "open"
filter stays accurate without anyone touching it.

Idempotency: this script may run repeatedly on the same data. If no new
failure cases are present and the most recent open prompt_tuner_runs row
covers the same evidence set, we skip the Claude call to save tokens.

Required env:
  - ANTHROPIC_API_KEY
  - GITHUB_TOKEN_PAT      (PAT with repo scope on the agent repo)
  - SUPABASE_URL
  - SUPABASE_SERVICE_KEY
  - GITHUB_REPOSITORY     (e.g. "trilogy-group/Lyncas"; GitHub Actions
                            sets this automatically; for local runs set
                            it to your fork's owner/name)

Optional env:
  - PROMPT_TUNER_MIN_FAILURES   (default 3, refuse to propose changes
                                  with fewer evidence cases — too noisy)
  - PROMPT_TUNER_MAX_CASES      (default 12, hard cap on cases bundled
                                  into the meta-prompt, oldest dropped
                                  first to keep input tokens bounded)
  - PROMPT_TUNER_BASE_BRANCH    (default "main")
  - PROMPT_TUNER_LOOKBACK_DAYS  (default 30)
"""

from __future__ import annotations

import difflib
import json
import os
import sys
from base64 import b64encode
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests
from anthropic import Anthropic
from supabase import Client, create_client


# --- Config ---------------------------------------------------------------

ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
GITHUB_TOKEN = os.environ["GITHUB_TOKEN_PAT"]
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
AGENT_REPO = os.environ.get("GITHUB_REPOSITORY") or os.environ.get("AGENT_REPO")
if not AGENT_REPO:
    print(
        "[FATAL] GITHUB_REPOSITORY (or AGENT_REPO) must be set to the "
        "owner/name of the agent repo so the prompt-tuner knows where "
        "to open the PR.",
        file=sys.stderr,
    )
    sys.exit(2)

MIN_FAILURES = int(os.environ.get("PROMPT_TUNER_MIN_FAILURES", "3"))
MAX_CASES = int(os.environ.get("PROMPT_TUNER_MAX_CASES", "12"))
BASE_BRANCH = os.environ.get("PROMPT_TUNER_BASE_BRANCH", "main")
LOOKBACK_DAYS = int(os.environ.get("PROMPT_TUNER_LOOKBACK_DAYS", "30"))

MODEL = "claude-opus-4-5"
META_PROMPT_MAX_TOKENS = 4000
PER_DIFF_TRUNCATE_CHARS = 4_000

PROMPT_PATH = Path(__file__).parent / "prompt.md"
PROMPT_REPO_PATH = "agent/prompt.md"

GITHUB_API = "https://api.github.com"
GH_HEADERS = {
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
anthropic_client = Anthropic(api_key=ANTHROPIC_API_KEY)


# --- Pull failure cases --------------------------------------------------

def list_recent_failures() -> list[dict]:
    """Settled false-close + missed-issue rows from the last LOOKBACK_DAYS,
    newest first. We later cap to MAX_CASES — keeping the most recent
    cases is intentional: drift the prompt-tuner cares about is what's
    been happening lately, not stale failures from prompt-versions ago."""
    since = (
        datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)
    ).isoformat()
    res = (
        supabase.table("human_actions")
        .select(
            "id, review_id, action_type, observed_at, "
            "pr_state, reopened, merged, reverted, notes"
        )
        .in_("action_type", ["false_close", "missed_issue"])
        .gte("observed_at", since)
        .order("observed_at", desc=True)
        .execute()
    )
    return res.data or []


def fetch_review(review_id: str) -> dict | None:
    """Fetch the full review row. We need the bug list, summary, and PR
    metadata so the meta-prompt can show Claude what the agent originally
    decided alongside what the human did."""
    res = (
        supabase.table("reviews")
        .select(
            "id, repo, pr_number, pr_url, pr_title, pr_author, "
            "verdict, confidence, severity_score, summary, "
            "bugs, concerns, action, gate_reason, "
            "critic_output, arbiter_output, escalated, created_at"
        )
        .eq("id", review_id)
        .limit(1)
        .execute()
    )
    rows = res.data or []
    return rows[0] if rows else None


def fetch_pr_diff(repo: str, pr_number: int) -> str:
    """Fetch the unified diff at PR-merge time (or current head). Best
    effort — if GitHub returns 404 (PR was hard-deleted) we just return
    "" and the case still goes to Claude, just without diff content."""
    try:
        r = requests.get(
            f"{GITHUB_API}/repos/{repo}/pulls/{pr_number}",
            headers={**GH_HEADERS, "Accept": "application/vnd.github.v3.diff"},
            timeout=30,
        )
        r.raise_for_status()
    except Exception as e:
        print(
            f"  [prompt-tuner] could not fetch diff for {repo}#{pr_number}: {e}",
            file=sys.stderr,
        )
        return ""
    diff = r.text
    if len(diff) > PER_DIFF_TRUNCATE_CHARS:
        diff = (
            diff[:PER_DIFF_TRUNCATE_CHARS]
            + "\n\n[... diff truncated for prompt-tuner ...]"
        )
    return diff


def bundle_cases(failures: list[dict]) -> list[dict]:
    """Join each failure with its review row and PR diff. Cases without a
    matching review row (cascade-deleted) are dropped silently."""
    bundles: list[dict] = []
    for fail in failures[:MAX_CASES]:
        review = fetch_review(fail["review_id"])
        if not review:
            continue
        diff = fetch_pr_diff(review["repo"], review["pr_number"])
        bundles.append(
            {
                "human_action_id": fail["id"],
                "review_id": review["id"],
                "repo": review["repo"],
                "pr_number": review["pr_number"],
                "pr_url": review["pr_url"],
                "pr_title": review["pr_title"],
                "action_type": fail["action_type"],
                "observed_at": fail["observed_at"],
                "agent_action": review.get("action"),
                "agent_verdict": review.get("verdict"),
                "agent_confidence": review.get("confidence"),
                "agent_severity": review.get("severity_score"),
                "agent_summary": review.get("summary"),
                "agent_bugs": review.get("bugs") or [],
                "diff": diff,
                "human_notes": fail.get("notes"),
            }
        )
    return bundles


# --- Compute baseline accuracy ------------------------------------------

def compute_baseline_accuracy() -> float:
    """Same arithmetic as /learning's headline accuracy stat over
    LOOKBACK_DAYS. Used as the "before" number on the PR description."""
    since = (
        datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)
    ).isoformat()
    res = (
        supabase.table("human_actions")
        .select("action_type")
        .gte("observed_at", since)
        .execute()
    )
    rows = res.data or []
    agreements = 0
    failures = 0
    for r in rows:
        t = r.get("action_type")
        if t in ("agreement_close", "agreement_approve"):
            agreements += 1
        elif t in ("false_close", "missed_issue"):
            failures += 1
    total = agreements + failures
    return (agreements / total * 100.0) if total else 0.0


# --- Meta-prompt --------------------------------------------------------

_META_SYSTEM_PROMPT = """You are improving the system prompt of an autonomous PR-review agent
based on cases where the agent's decision disagreed with the human's
ground truth (PRs the agent closed but a human reopened, and PRs the
agent approved that were later reverted).

You receive:
  1. The current full agent system prompt (`prompt.md`).
  2. A list of failure cases. For each: the diff, what the agent decided,
     and what the human did instead.

Your job is to propose a SPECIFIC, MINIMAL revision of the prompt that
would have caused the agent to make the *correct* call on these cases
without regressing the rest of the prompt's behavior. Prefer surgical
edits — added rules, sharpened severity rubric clauses, new
"watch-for-this" entries — over wholesale rewrites.

Hard rules:
  - Output strict JSON only. No prose before or after, no code fences.
  - Preserve the prompt's structure (the same headings, in the same
    order). Edit content, not skeleton.
  - Do NOT remove existing rules unless they are directly contradicted
    by an evidence case. If you remove anything, justify it in the
    rationale.
  - The "Hard rules — these are non-negotiable" section is sacrosanct
    on intent. You may sharpen its wording, but never relax it.
  - Your `accuracy_after_pct_estimate` is a rough guess (0..100). Be
    conservative. If you can't credibly estimate an improvement, set
    it equal to the baseline.

Schema:
{
  "new_prompt": "the FULL revised contents of prompt.md, ready to commit",
  "rationale": "2-4 sentences: which failure modes drove the change, and
                which prompt edits address each",
  "accuracy_after_pct_estimate": <number, 0..100>
}"""


def build_meta_user_message(
    current_prompt: str, cases: list[dict], baseline_pct: float
) -> str:
    """Render the failure cases compactly so we leave room for Claude's
    new full-prompt output in the response budget."""
    lines: list[str] = []
    lines.append(
        f"BASELINE AGENT ACCURACY (last {LOOKBACK_DAYS}d, agreements / "
        f"non-pending observations): {baseline_pct:.1f}%"
    )
    lines.append("")
    lines.append(f"FAILURE CASES ({len(cases)} cases):")
    lines.append("")
    for i, c in enumerate(cases, 1):
        bug_summaries = []
        for b in (c.get("agent_bugs") or [])[:5]:
            sev = (b.get("severity") or "?").lower()
            issue = (b.get("issue") or "").strip()
            if issue:
                bug_summaries.append(f"  - [{sev}] {issue}")
        bug_block = "\n".join(bug_summaries) if bug_summaries else "  (none)"

        lines.append(f"### Case {i}: {c['repo']}#{c['pr_number']} — {c['pr_title']}")
        lines.append(f"  failure type:    {c['action_type']}")
        lines.append(f"  agent action:    {c.get('agent_action') or '?'}")
        lines.append(
            f"  agent verdict:   {c.get('agent_verdict') or '?'} "
            f"(confidence={c.get('agent_confidence') or '?'}, "
            f"severity={c.get('agent_severity') if c.get('agent_severity') is not None else '?'})"
        )
        lines.append(f"  agent summary:   {(c.get('agent_summary') or '').strip()[:240]}")
        lines.append("  agent bugs:")
        lines.append(bug_block)
        if c.get("human_notes"):
            lines.append(f"  human notes:     {c['human_notes']}")
        lines.append(f"  diff (truncated to {PER_DIFF_TRUNCATE_CHARS} chars):")
        lines.append("  ```diff")
        for ln in (c.get("diff") or "(diff unavailable)").splitlines():
            lines.append(f"  {ln}")
        lines.append("  ```")
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("CURRENT PROMPT.MD:")
    lines.append("```markdown")
    lines.append(current_prompt)
    lines.append("```")
    lines.append("")
    lines.append(
        "Now produce the JSON object per the system-prompt schema. "
        "The `new_prompt` field MUST be the full new prompt.md "
        "(everything that should land in the file)."
    )
    return "\n".join(lines)


def call_meta_prompt(
    current_prompt: str, cases: list[dict], baseline_pct: float
) -> dict:
    """One Claude call → JSON object with new_prompt, rationale,
    accuracy_after_pct_estimate. Raises on parse failure; the caller
    decides whether to surface the error or skip the run."""
    user_msg = build_meta_user_message(current_prompt, cases, baseline_pct)
    response = anthropic_client.messages.create(
        model=MODEL,
        max_tokens=META_PROMPT_MAX_TOKENS,
        system=_META_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_msg}],
    )
    raw = response.content[0].text.strip()
    text = _strip_outer_fence(raw)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(
            f"meta prompt returned invalid JSON: {e} — first 200 chars: {text[:200]}"
        ) from e
    if not isinstance(parsed, dict) or not parsed.get("new_prompt"):
        raise ValueError("meta prompt JSON is missing required `new_prompt` field")
    return parsed


def _strip_outer_fence(text: str) -> str:
    """Mirror of review_graph._strip_outer_fence — Claude sometimes wraps
    JSON in ```json...``` despite instructions. Strip only the outermost
    fence to preserve any inner fences inside string values."""
    text = text.strip()
    if text.startswith("```"):
        first_nl = text.find("\n")
        text = text[first_nl + 1 :] if first_nl != -1 else text[3:]
        text = text.rstrip()
        if text.endswith("```"):
            text = text[:-3].rstrip()
    return text


# --- GitHub PR creation -------------------------------------------------

def github_get_branch_sha(repo: str, branch: str) -> str:
    r = requests.get(
        f"{GITHUB_API}/repos/{repo}/git/ref/heads/{branch}",
        headers=GH_HEADERS,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["object"]["sha"]


def github_create_branch(repo: str, branch: str, base_sha: str) -> None:
    r = requests.post(
        f"{GITHUB_API}/repos/{repo}/git/refs",
        headers=GH_HEADERS,
        json={"ref": f"refs/heads/{branch}", "sha": base_sha},
        timeout=30,
    )
    if r.status_code == 422:
        # Branch already exists — extremely unlikely with our timestamp
        # naming, but treat as fatal so we don't accidentally overwrite a
        # human's work.
        raise RuntimeError(
            f"branch {branch} already exists on {repo} — refusing to reuse"
        )
    r.raise_for_status()


def github_get_file_sha(repo: str, path: str, ref: str) -> str | None:
    r = requests.get(
        f"{GITHUB_API}/repos/{repo}/contents/{path}",
        headers=GH_HEADERS,
        params={"ref": ref},
        timeout=30,
    )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json().get("sha")


def github_put_file(
    repo: str, path: str, branch: str, message: str, content: str, sha: str | None
) -> None:
    payload: dict[str, Any] = {
        "message": message,
        "content": b64encode(content.encode("utf-8")).decode("ascii"),
        "branch": branch,
    }
    if sha:
        payload["sha"] = sha
    r = requests.put(
        f"{GITHUB_API}/repos/{repo}/contents/{path}",
        headers=GH_HEADERS,
        json=payload,
        timeout=30,
    )
    r.raise_for_status()


def github_open_pr(
    repo: str, branch: str, base: str, title: str, body: str
) -> dict:
    r = requests.post(
        f"{GITHUB_API}/repos/{repo}/pulls",
        headers=GH_HEADERS,
        json={"head": branch, "base": base, "title": title, "body": body},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def github_get_pr_state(repo: str, pr_number: int) -> str:
    """Return one of: open / merged / closed / unknown."""
    try:
        r = requests.get(
            f"{GITHUB_API}/repos/{repo}/pulls/{pr_number}",
            headers=GH_HEADERS,
            timeout=30,
        )
        r.raise_for_status()
    except Exception:
        return "unknown"
    pr = r.json()
    if pr.get("merged"):
        return "merged"
    return pr.get("state") or "unknown"


# --- Persistence --------------------------------------------------------

def insert_run(
    *,
    pr: dict,
    branch: str,
    cases: list[dict],
    proposed_diff: str,
    rationale: str,
    accuracy_before: float,
    accuracy_after_estimate: float,
) -> None:
    """One row per opened PR. The dashboard renders these via
    getOpenPromptTunerRuns()."""
    payload = {
        "pr_url": pr["html_url"],
        "pr_number": pr["number"],
        "pr_title": pr["title"],
        "branch_name": branch,
        "base_branch": BASE_BRANCH,
        "agent_repo": AGENT_REPO,
        "failure_case_count": len(cases),
        # Strip the heavy `diff` field from each case before persisting —
        # the dashboard only renders the pointer + summary, and the full
        # diff is already in the proposed_diff column for prompt.md plus
        # on GitHub for each PR.
        "failure_cases": [
            {
                k: v for k, v in c.items() if k != "diff"
            }
            for c in cases
        ],
        "proposed_diff": proposed_diff,
        "rationale": rationale,
        "accuracy_before_pct": accuracy_before,
        "accuracy_after_pct_est": accuracy_after_estimate,
        "status": "open",
        "status_observed_at": datetime.now(timezone.utc).isoformat(),
    }
    supabase.table("prompt_tuner_runs").upsert(
        payload, on_conflict="agent_repo,pr_number"
    ).execute()


def refresh_open_run_statuses() -> None:
    """Poll GitHub for the current state of every prompt_tuner_runs row
    that we last saw as open. Flips status to merged/closed/unknown so
    the dashboard's "open" filter stays accurate."""
    res = (
        supabase.table("prompt_tuner_runs")
        .select("id, agent_repo, pr_number")
        .eq("status", "open")
        .execute()
    )
    rows = res.data or []
    if not rows:
        return
    print(
        f"[prompt-tuner] refreshing status of {len(rows)} previously-open run(s)"
    )
    for row in rows:
        new_status = github_get_pr_state(row["agent_repo"], row["pr_number"])
        if new_status != "open":
            supabase.table("prompt_tuner_runs").update(
                {
                    "status": new_status,
                    "status_observed_at": datetime.now(timezone.utc).isoformat(),
                }
            ).eq("id", row["id"]).execute()
            print(
                f"  [{row['agent_repo']}#{row['pr_number']}] open → {new_status}"
            )


# --- Diff ---------------------------------------------------------------

def compute_unified_diff(old: str, new: str, path: str) -> str:
    return "".join(
        difflib.unified_diff(
            old.splitlines(keepends=True),
            new.splitlines(keepends=True),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
            n=3,
        )
    )


# --- PR body ------------------------------------------------------------

PR_BODY_HEADER = (
    "<!-- prompt-tuner:auto -->\n"
    "## 🧠 Prompt-tuner proposal\n\n"
    "This PR was opened automatically by `agent/prompt_tuner.py`. "
    "It proposes an edit to `agent/prompt.md` based on cases where the "
    "agent's decision disagreed with the human's ground truth.\n\n"
    "**The agent never merges its own PR.** Review the diff and the "
    "rationale below before merging.\n\n"
)


def build_pr_body(
    *,
    cases: list[dict],
    rationale: str,
    accuracy_before: float,
    accuracy_after_estimate: float,
) -> str:
    """The PR description on GitHub. Includes the failure-case table, the
    rationale, and accuracy-before vs estimated-accuracy-after."""
    lines: list[str] = [PR_BODY_HEADER]

    lines.append("### Rationale")
    lines.append("")
    lines.append(rationale.strip() or "(no rationale provided by model)")
    lines.append("")

    lines.append("### Projected impact")
    lines.append("")
    lines.append(f"- **Baseline accuracy (last {LOOKBACK_DAYS}d):** {accuracy_before:.1f}%")
    lines.append(
        f"- **Estimated accuracy after this change:** {accuracy_after_estimate:.1f}% "
        "_(rough model self-estimate; not a guarantee)_"
    )
    lines.append("")

    lines.append(f"### Failure cases driving this proposal ({len(cases)})")
    lines.append("")
    lines.append("| # | PR | type | agent verdict | severity | observed |")
    lines.append("|---|----|------|---------------|----------|----------|")
    for i, c in enumerate(cases, 1):
        sev = c.get("agent_severity")
        sev_text = str(sev) if sev is not None else "?"
        lines.append(
            f"| {i} "
            f"| [{c['repo']}#{c['pr_number']}]({c['pr_url']}) "
            f"| `{c['action_type']}` "
            f"| `{c.get('agent_verdict') or '?'}` "
            f"| {sev_text} "
            f"| {c['observed_at']} |"
        )
    lines.append("")
    lines.append(
        "_The full per-case diff and bug list were given to Claude as "
        "evidence; they're omitted here for readability._"
    )
    lines.append("")
    lines.append("---")
    lines.append(
        "*Generated by `agent/prompt_tuner.py`. To suppress future runs "
        "of this loop, set `PROMPT_TUNER_MIN_FAILURES` higher in the "
        "workflow env, or disable the prompt-tuner job.*"
    )
    return "\n".join(lines)


# --- Main ----------------------------------------------------------------

def main() -> int:
    print(f"[startup] prompt-tuner: agent_repo={AGENT_REPO}, "
          f"lookback={LOOKBACK_DAYS}d, min_failures={MIN_FAILURES}")

    # Always refresh statuses first — even on a "no new failures" run we
    # want the dashboard's "open" list to be accurate.
    try:
        refresh_open_run_statuses()
    except Exception as e:
        print(f"[prompt-tuner] status refresh failed (non-fatal): {e}", file=sys.stderr)

    failures = list_recent_failures()
    print(
        f"[prompt-tuner] {len(failures)} failure case(s) in the last "
        f"{LOOKBACK_DAYS}d (false_close + missed_issue)"
    )
    if len(failures) < MIN_FAILURES:
        print(
            f"[prompt-tuner] under threshold ({MIN_FAILURES}); skipping "
            "PR proposal — re-run when more evidence is available"
        )
        return 0

    cases = bundle_cases(failures)
    if len(cases) < MIN_FAILURES:
        print(
            f"[prompt-tuner] only {len(cases)} cases survived review-row "
            "join (rest were missing); skipping"
        )
        return 0

    baseline_pct = compute_baseline_accuracy()
    current_prompt = PROMPT_PATH.read_text(encoding="utf-8")
    print(
        f"[prompt-tuner] calling Claude meta-prompt "
        f"(model={MODEL}, cases={len(cases)}, baseline={baseline_pct:.1f}%)"
    )
    try:
        proposal = call_meta_prompt(current_prompt, cases, baseline_pct)
    except Exception as e:
        print(f"[FATAL] meta-prompt call failed: {e}", file=sys.stderr)
        return 1

    new_prompt: str = proposal["new_prompt"]
    rationale: str = (proposal.get("rationale") or "").strip()
    accuracy_after_estimate = float(
        proposal.get("accuracy_after_pct_estimate") or baseline_pct
    )

    proposed_diff = compute_unified_diff(
        current_prompt, new_prompt, PROMPT_REPO_PATH
    )
    if not proposed_diff.strip():
        print(
            "[prompt-tuner] model returned an unchanged prompt — no PR to "
            "open, exiting cleanly"
        )
        return 0

    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    branch = f"prompt-tuner/{ts}"
    print(f"[prompt-tuner] opening PR on {AGENT_REPO} via branch {branch}")

    try:
        base_sha = github_get_branch_sha(AGENT_REPO, BASE_BRANCH)
        github_create_branch(AGENT_REPO, branch, base_sha)
        existing_sha = github_get_file_sha(AGENT_REPO, PROMPT_REPO_PATH, branch)
        github_put_file(
            AGENT_REPO,
            PROMPT_REPO_PATH,
            branch,
            f"prompt-tuner: propose prompt.md update from {len(cases)} failure cases",
            new_prompt,
            existing_sha,
        )
        title = (
            f"prompt-tuner: prompt.md update from {len(cases)} failure cases "
            f"({ts})"
        )
        body = build_pr_body(
            cases=cases,
            rationale=rationale,
            accuracy_before=baseline_pct,
            accuracy_after_estimate=accuracy_after_estimate,
        )
        pr = github_open_pr(AGENT_REPO, branch, BASE_BRANCH, title, body)
    except Exception as e:
        print(f"[FATAL] opening PR failed: {e}", file=sys.stderr)
        return 1

    print(
        f"[prompt-tuner] opened {pr['html_url']} — DO NOT merge automatically"
    )

    try:
        insert_run(
            pr=pr,
            branch=branch,
            cases=cases,
            proposed_diff=proposed_diff,
            rationale=rationale,
            accuracy_before=baseline_pct,
            accuracy_after_estimate=accuracy_after_estimate,
        )
    except Exception as e:
        # PR is already open — DB write failure is recoverable; the next
        # run will re-poll the PR's state and bring it into the table via
        # refresh_open_run_statuses (which only updates rows it already
        # has, so we'd need a follow-up scan to recover this one). Log
        # loudly and exit non-zero so the workflow surfaces the issue.
        print(
            f"[ERROR] PR opened ({pr['html_url']}) but Supabase upsert failed: {e}",
            file=sys.stderr,
        )
        return 1

    print("[prompt-tuner] done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
