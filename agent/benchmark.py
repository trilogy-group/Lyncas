"""
Sonnet vs Opus benchmark — re-run a sample of existing reviews through
Opus, compute simple agreement metrics, and write the comparison to the
`benchmark_runs` table. The /benchmark dashboard page reads from there.

Run manually (this is not wired into GitHub Actions on purpose — Opus is
~5x the cost of Sonnet and we don't want it firing on every PR):

    cd agent && python benchmark.py --latest 5
    cd agent && python benchmark.py --review-ids uuid1,uuid2,uuid3

Requires the same env vars as pr_reviewer.py:
    ANTHROPIC_API_KEY       — for the Opus call
    GITHUB_TOKEN_PAT        — to refetch the diff
    SUPABASE_URL            — for reading reviews + writing benchmarks
    SUPABASE_SERVICE_KEY    — service role (bypasses RLS for writes)

REPOS is intentionally NOT required: benchmark.py works off review IDs
that are already in the database.

Methodology notes:
 - We re-fetch the diff from GitHub at benchmark time so we're comparing
   models on the *same input bytes*. If the PR has been pushed-to since
   the original review, the diff may differ — that's fine for v1, just
   know the comparison is "current diff" not "diff at review time".
 - We do NOT re-run Sonnet. The Sonnet output is copied verbatim from
   the reviews row. This is cheaper and avoids confounding the
   comparison with Sonnet's own run-to-run variance.
 - Bug overlap is a 70%-token-Jaccard heuristic on (file + first 60
   chars of issue text). It's a first-pass heuristic, intentionally
   simple — see the methodology blurb on the dashboard page.
"""

import argparse
import os
import re
import sys
from typing import Any

from supabase import Client, create_client

# DRY reuse: same prompt, same parsing logic, same diff fetcher as the
# production agent. Only the model string changes. We import these
# directly from pr_reviewer rather than duplicating ~50 lines of
# API-call + JSON-parse logic that would inevitably drift out of sync.
from pr_reviewer import (  # noqa: E402  (intentional ordering — env vars validated by pr_reviewer's module load)
    MAX_DIFF_CHARS,
    MODEL as SONNET_MODEL,
    get_pr_diff,
    review_pr_with_claude,
)

# The Opus model string. Edit this when a new Opus version ships.
OPUS_MODEL = "claude-opus-4-5"

# Pricing in micro-USD per token (1 USD = 1,000,000 micros). We store
# cost as int micro-USD to avoid float rounding artifacts in summary math.
#   Sonnet: $3  per 1M input,  $15 per 1M output  → 3  and 15 micros/token
#   Opus:   $15 per 1M input,  $75 per 1M output  → 15 and 75 micros/token
PRICING_MICROS = {
    SONNET_MODEL: {"in": 3, "out": 15},
    OPUS_MODEL: {"in": 15, "out": 75},
}

# Jaccard threshold above which two bug entries are considered "the same"
# bug across models. Heuristic — see module docstring.
BUG_OVERLAP_THRESHOLD = 0.7


def _supabase() -> Client:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        print(
            "[ERROR] SUPABASE_URL and SUPABASE_SERVICE_KEY must be set",
            file=sys.stderr,
        )
        sys.exit(2)
    return create_client(url, key)


def _bug_tokens(bug: dict) -> set[str]:
    """Tokenize (file + first-60-chars-of-issue) for Jaccard comparison.

    Lowercase, word characters only. Empty fields collapse to empty sets,
    which Jaccard then handles below."""
    file_part = (bug.get("file") or "").strip()
    issue_part = (bug.get("issue") or "").strip()[:60]
    text = f"{file_part} {issue_part}".lower()
    return set(re.findall(r"\w+", text))


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _match_bugs(
    sonnet_bugs: list[dict],
    opus_bugs: list[dict],
) -> tuple[int, int, int]:
    """Greedy bug matching by Jaccard on (file + issue prefix) tokens.

    For each Sonnet bug, pick the highest-Jaccard unmatched Opus bug;
    if that score clears the threshold, count it as a match. Greedy
    not optimal — fine for typical bug-list sizes (≤10) and consistent
    with "don't over-engineer the similarity".

    Returns (overlap_count, only_in_sonnet, only_in_opus).
    """
    s_tokens = [_bug_tokens(b) for b in sonnet_bugs]
    o_tokens = [_bug_tokens(b) for b in opus_bugs]
    matched_opus: set[int] = set()
    overlap = 0
    for si in range(len(sonnet_bugs)):
        best_j = -1
        best_score = 0.0
        for oj in range(len(opus_bugs)):
            if oj in matched_opus:
                continue
            score = _jaccard(s_tokens[si], o_tokens[oj])
            if score > best_score:
                best_score = score
                best_j = oj
        if best_j >= 0 and best_score >= BUG_OVERLAP_THRESHOLD:
            matched_opus.add(best_j)
            overlap += 1
    return overlap, len(sonnet_bugs) - overlap, len(opus_bugs) - overlap


def _cost_micros(model: str, input_tokens: int | None, output_tokens: int | None) -> int:
    p = PRICING_MICROS[model]
    return (input_tokens or 0) * p["in"] + (output_tokens or 0) * p["out"]


def _synth_pr_for_prompt(review_row: dict) -> dict:
    """Synthesize the minimal GitHub PR dict that review_pr_with_claude()
    needs to format its user message. The reviews table has everything
    we actually use; the rest is filled with sensible placeholders."""
    return {
        "title": review_row["pr_title"],
        # body isn't stored in reviews; the original prompt handles
        # missing bodies via `or '(none)'`, so empty string is fine
        "body": "",
        "number": review_row["pr_number"],
        "html_url": review_row["pr_url"],
        "user": {"login": review_row.get("pr_author") or "unknown"},
        # base.ref isn't stored either; the prompt only references it
        # for context, not for any logic
        "base": {"ref": "unknown"},
        "changed_files": "unknown",
        "additions": "?",
        "deletions": "?",
    }


def benchmark_one(sb: Client, review_row: dict, idx: int, total: int) -> bool:
    """Run one review through Opus and persist the comparison row.

    Returns True on success, False on any handled failure (network, API,
    DB). Never raises — failures are logged and we move on to the next."""
    repo = review_row["repo"]
    pr_number = review_row["pr_number"]
    review_id = review_row["id"]
    tag = f"{repo}#{pr_number}"
    print(f"[{idx}/{total}] reviewing {tag} with Opus (review_id={review_id})...")

    try:
        diff = get_pr_diff(repo, pr_number)
    except Exception as e:
        print(f"  ⚠️  failed to refetch diff: {e}", file=sys.stderr)
        return False

    try:
        opus_result = review_pr_with_claude(
            _synth_pr_for_prompt(review_row),
            diff,
            model=OPUS_MODEL,
        )
    except Exception as e:
        print(f"  ⚠️  Opus call failed: {e}", file=sys.stderr)
        return False

    sonnet_bugs: list[dict] = review_row.get("bugs") or []
    opus_bugs: list[dict] = opus_result.get("bugs") or []
    overlap, only_s, only_o = _match_bugs(sonnet_bugs, opus_bugs)

    s_in = review_row.get("input_tokens")
    s_out = review_row.get("output_tokens")
    o_in = opus_result.get("_input_tokens")
    o_out = opus_result.get("_output_tokens")

    opus_verdict = opus_result.get("verdict")
    opus_severity = opus_result.get("severity_score")

    payload: dict[str, Any] = {
        "review_id": review_id,
        "pr_url": review_row["pr_url"],
        "pr_title": review_row["pr_title"],
        # Sonnet side: snapshot from the original review row
        "sonnet_verdict": review_row["verdict"],
        "sonnet_confidence": review_row["confidence"],
        "sonnet_severity": review_row["severity_score"],
        "sonnet_bugs": sonnet_bugs,
        "sonnet_summary": review_row.get("summary"),
        "sonnet_input_tokens": s_in,
        "sonnet_output_tokens": s_out,
        # Opus side: this run
        "opus_verdict": opus_verdict,
        "opus_confidence": opus_result.get("confidence"),
        "opus_severity": opus_severity,
        "opus_bugs": opus_bugs,
        "opus_summary": opus_result.get("summary"),
        "opus_input_tokens": o_in,
        "opus_output_tokens": o_out,
        # Derived metrics
        "verdict_agreement": review_row["verdict"] == opus_verdict,
        "severity_delta": abs(
            int(review_row["severity_score"]) - int(opus_severity or 0)
        ),
        "bug_overlap_count": overlap,
        "bugs_only_in_sonnet": only_s,
        "bugs_only_in_opus": only_o,
        "sonnet_cost_micros": _cost_micros(SONNET_MODEL, s_in, s_out),
        "opus_cost_micros": _cost_micros(OPUS_MODEL, o_in, o_out),
    }

    try:
        sb.table("benchmark_runs").insert(payload).execute()
    except Exception as e:
        print(f"  ⚠️  failed to insert benchmark row: {e}", file=sys.stderr)
        return False

    print(
        f"  ✓ verdict {review_row['verdict']} vs {opus_verdict}, "
        f"sev {review_row['severity_score']} vs {opus_severity}, "
        f"bugs {overlap} matched / {only_s} only-sonnet / {only_o} only-opus"
    )
    return True


def select_reviews(sb: Client, ids: list[str] | None, latest: int | None) -> list[dict]:
    q = sb.table("reviews").select("*")
    if ids:
        q = q.in_("id", ids)
    else:
        q = q.order("created_at", desc=True).limit(latest or 5)
    res = q.execute()
    return res.data or []


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Re-run reviews through Opus and store the comparison.",
    )
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument(
        "--review-ids",
        help="Comma-separated review UUIDs to benchmark.",
    )
    g.add_argument(
        "--latest",
        type=int,
        help="Benchmark the N most recent reviews from the reviews table.",
    )
    args = ap.parse_args()

    sb = _supabase()

    if args.review_ids:
        ids = [s.strip() for s in args.review_ids.split(",") if s.strip()]
        if not ids:
            print("[ERROR] --review-ids was empty after parsing", file=sys.stderr)
            return 2
        rows = select_reviews(sb, ids, None)
    else:
        rows = select_reviews(sb, None, args.latest)

    if not rows:
        print("No reviews matched the selector. Nothing to benchmark.", file=sys.stderr)
        return 1

    print(
        f"Benchmarking {len(rows)} review(s) against {OPUS_MODEL} "
        f"(sonnet={SONNET_MODEL}, max_diff_chars={MAX_DIFF_CHARS})...\n"
    )

    ok = 0
    for i, row in enumerate(rows, start=1):
        if benchmark_one(sb, row, i, len(rows)):
            ok += 1

    print(f"\nDone. {ok}/{len(rows)} benchmarks recorded in benchmark_runs.")
    return 0 if ok == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
