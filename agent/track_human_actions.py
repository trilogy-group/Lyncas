"""
track_human_actions.py — poll GitHub for human responses to agent reviews
and classify each one as agreement / failure / pending. Phase 7.

For every review made in the last REVIEW_LOOKBACK_DAYS (7) that does not
already have a settled `human_actions` row, this script:

  1. fetches the PR's current state on GitHub,
  2. (when applicable) looks for revert commits on the base branch
     within REVERT_LOOKBACK_DAYS (7) of merge,
  3. classifies the outcome per the Phase 7 spec:

        Agent action == "closed":
          PR state == "open"   -> false_close       (human reopened)
          PR state == "closed" -> agreement_close   (still closed)

        Agent action == "commented":
          PR merged + revert  -> missed_issue
          PR merged, no revert -> agreement_approve
          otherwise           -> pending

  4. upserts the result into human_actions (unique on review_id, so
     repeated polls overwrite cleanly).

After the polling loop it computes two drift rates over the last
DRIFT_LOOKBACK_DAYS (30):

   false_close_rate  = false_closes / total_closes
   missed_issue_rate = missed_issues / total_approves

If either exceeds DRIFT_THRESHOLD (0.05 == 5%) AND no unresolved
agent_alerts row of the same type already exists, a new agent_alerts
row is inserted. The /learning dashboard renders these as a red
banner.

Run on the 6-hour cron defined in .github/workflows/pr-review.yml.
"""

import os
import sys
from datetime import datetime, timedelta, timezone

import requests
from supabase import Client, create_client


# --- Config ---------------------------------------------------------------

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
GITHUB_TOKEN = os.environ["GITHUB_TOKEN_PAT"]

GITHUB_API = "https://api.github.com"
GH_HEADERS = {
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

REVIEW_LOOKBACK_DAYS = 7
DRIFT_LOOKBACK_DAYS = 30
DRIFT_THRESHOLD = 0.05
REVERT_LOOKBACK_DAYS = 7

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


# --- Pull "what still needs polling?" ------------------------------------

def list_reviews_to_poll() -> list[dict]:
    """Return reviews from the last REVIEW_LOOKBACK_DAYS that either have
    no human_actions row or whose row is still 'pending'. Anything else
    (already settled into one of the four terminal classifications) is
    considered done and won't be re-polled."""
    since = (
        datetime.now(timezone.utc) - timedelta(days=REVIEW_LOOKBACK_DAYS)
    ).isoformat()

    reviews_resp = (
        supabase.table("reviews")
        .select("id, repo, pr_number, action, created_at")
        .gte("created_at", since)
        .execute()
    )
    reviews = reviews_resp.data or []
    if not reviews:
        return []

    review_ids = [r["id"] for r in reviews]
    actions_resp = (
        supabase.table("human_actions")
        .select("review_id, action_type, poll_count")
        .in_("review_id", review_ids)
        .execute()
    )
    existing_by_id = {a["review_id"]: a for a in (actions_resp.data or [])}

    todo: list[dict] = []
    for r in reviews:
        existing = existing_by_id.get(r["id"])
        if existing and existing.get("action_type") != "pending":
            continue
        r["_prev_poll_count"] = (existing or {}).get("poll_count", 0)
        todo.append(r)
    return todo


# --- GitHub-side fetches -------------------------------------------------

def get_pr_state(repo: str, pr_number: int) -> dict:
    """Fetch the current PR state via the pulls API.

    Returns the subset we care about; raises on any non-2xx so the caller
    can catch and continue on to the next review."""
    r = requests.get(
        f"{GITHUB_API}/repos/{repo}/pulls/{pr_number}",
        headers=GH_HEADERS,
        timeout=30,
    )
    r.raise_for_status()
    pr = r.json()
    return {
        "state": pr["state"],
        "merged": pr.get("merged", False),
        "merged_at": pr.get("merged_at"),
        "base_ref": pr.get("base", {}).get("ref"),
        "merge_commit_sha": pr.get("merge_commit_sha"),
    }


def has_revert_commit(
    repo: str, base_ref: str | None, merged_at: str | None, pr_number: int
) -> bool:
    """Look for revert commits on `base_ref` within REVERT_LOOKBACK_DAYS
    after `merged_at`. Conservative match: the commit message must start
    with "revert" (case-insensitive) AND contain `#<pr_number>` — that's
    the format GitHub's "Revert this PR" UI button produces."""
    if not base_ref or not merged_at:
        return False
    try:
        merged_dt = datetime.fromisoformat(merged_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    until_dt = merged_dt + timedelta(days=REVERT_LOOKBACK_DAYS)

    r = requests.get(
        f"{GITHUB_API}/repos/{repo}/commits",
        headers=GH_HEADERS,
        params={
            "sha": base_ref,
            "since": merged_dt.isoformat(),
            "until": until_dt.isoformat(),
            "per_page": 100,
        },
        timeout=30,
    )
    r.raise_for_status()

    needle = f"#{pr_number}"
    for c in r.json():
        msg = (c.get("commit", {}).get("message") or "")
        if not msg:
            continue
        first_line = msg.splitlines()[0].lower()
        if first_line.startswith("revert") and needle in msg:
            return True
    return False


# --- Classifier ----------------------------------------------------------

def classify(action: str, pr_state: dict, reverted: bool) -> str:
    """Apply the five-bucket rule from the Phase 7 spec. Returns one of:
    agreement_close / false_close / agreement_approve / missed_issue / pending."""
    state = pr_state.get("state")
    merged = pr_state.get("merged", False)

    if action == "closed":
        # The agent (or a maintainer following its recommendation) closed
        # the PR. The signal is whether the human reopened it.
        if state == "open":
            return "false_close"
        # state == "closed" — still closed by both human and agent
        return "agreement_close"

    if action == "commented":
        # The agent only commented. We can only judge once the PR has
        # been merged; until then it's pending.
        if merged:
            return "missed_issue" if reverted else "agreement_approve"
        return "pending"

    return "pending"


# --- Upsert --------------------------------------------------------------

def upsert_human_action(
    *,
    review_id: str,
    pr_state: dict,
    classification: str,
    reverted: bool,
    prev_poll_count: int,
) -> None:
    payload = {
        "review_id": review_id,
        "action_type": classification,
        "pr_state": pr_state.get("state") or "unknown",
        "reopened": classification == "false_close",
        "merged": bool(pr_state.get("merged", False)),
        "reverted": reverted,
        "poll_count": prev_poll_count + 1,
        "observed_at": datetime.now(timezone.utc).isoformat(),
    }
    supabase.table("human_actions").upsert(
        payload, on_conflict="review_id"
    ).execute()


# --- Drift detection -----------------------------------------------------

def compute_drift_and_alert() -> None:
    """Compute false_close_rate + missed_issue_rate over the last
    DRIFT_LOOKBACK_DAYS and insert agent_alerts rows when either crosses
    DRIFT_THRESHOLD.

    Implementation note: we deliberately fetch reviews and human_actions
    separately and join in Python rather than relying on PostgREST's
    embedded-resource join syntax. Plain queries are simpler to reason
    about and don't depend on RLS-policy quirks that affect joins."""
    since = (
        datetime.now(timezone.utc) - timedelta(days=DRIFT_LOOKBACK_DAYS)
    ).isoformat()

    reviews_resp = (
        supabase.table("reviews")
        .select("id, action")
        .gte("created_at", since)
        .execute()
    )
    review_action_by_id: dict[str, str] = {
        r["id"]: r["action"] for r in (reviews_resp.data or [])
    }
    if not review_action_by_id:
        print(f"[drift] no reviews in the last {DRIFT_LOOKBACK_DAYS}d — skipping")
        return

    actions_resp = (
        supabase.table("human_actions")
        .select("review_id, action_type")
        .in_("review_id", list(review_action_by_id.keys()))
        .execute()
    )

    closes = 0
    false_closes = 0
    approves = 0
    missed_issues = 0
    for row in actions_resp.data or []:
        review_action = review_action_by_id.get(row["review_id"])
        action_type = row.get("action_type")
        if review_action == "closed":
            closes += 1
            if action_type == "false_close":
                false_closes += 1
        elif review_action == "commented" and action_type in (
            "agreement_approve",
            "missed_issue",
        ):
            approves += 1
            if action_type == "missed_issue":
                missed_issues += 1

    fc_rate = (false_closes / closes) if closes else 0.0
    mi_rate = (missed_issues / approves) if approves else 0.0

    print(
        f"[drift] last {DRIFT_LOOKBACK_DAYS}d: "
        f"{closes} closes ({false_closes} false → {fc_rate:.1%}), "
        f"{approves} approves ({missed_issues} missed → {mi_rate:.1%})"
    )

    for alert_type, value in (
        ("false_close_rate", fc_rate),
        ("missed_issue_rate", mi_rate),
    ):
        if value <= DRIFT_THRESHOLD:
            continue
        # Don't insert a second open alert of the same type — wait until
        # the existing one is resolved manually.
        existing = (
            supabase.table("agent_alerts")
            .select("id")
            .eq("alert_type", alert_type)
            .is_("resolved_at", "null")
            .limit(1)
            .execute()
        )
        if existing.data:
            print(
                f"[drift] {alert_type}={value:.2%} > {DRIFT_THRESHOLD:.0%} — "
                "unresolved alert already exists, skipping insert"
            )
            continue
        print(
            f"[drift] {alert_type}={value:.2%} > {DRIFT_THRESHOLD:.0%} → "
            "raising agent_alert"
        )
        supabase.table("agent_alerts").insert(
            {
                "alert_type": alert_type,
                "metric_value": value,
                "threshold": DRIFT_THRESHOLD,
            }
        ).execute()


# --- Main ----------------------------------------------------------------

def main() -> int:
    print(f"[startup] polling human actions (lookback={REVIEW_LOOKBACK_DAYS}d)")
    pending = list_reviews_to_poll()
    print(f"[startup] {len(pending)} review(s) need polling")

    polled = 0
    errors: list[str] = []
    for review in pending:
        repo = review["repo"]
        num = review["pr_number"]
        tag = f"{repo}#{num}"
        try:
            pr_state = get_pr_state(repo, num)
            reverted = False
            if review["action"] == "commented" and pr_state.get("merged"):
                reverted = has_revert_commit(
                    repo, pr_state["base_ref"], pr_state["merged_at"], num
                )
            classification = classify(review["action"], pr_state, reverted)
            upsert_human_action(
                review_id=review["id"],
                pr_state=pr_state,
                classification=classification,
                reverted=reverted,
                prev_poll_count=review["_prev_poll_count"],
            )
            print(
                f"  [{tag}] agent={review['action']} → {classification} "
                f"(state={pr_state['state']}, merged={pr_state['merged']}, "
                f"reverted={reverted})"
            )
            polled += 1
        except Exception as e:
            print(f"  [{tag}] error: {e}", file=sys.stderr)
            errors.append(f"{tag}: {e}")

    print(
        f"\n[summary] {polled} polled, {len(errors)} errored "
        f"(out of {len(pending)} candidates)"
    )

    try:
        compute_drift_and_alert()
    except Exception as e:
        print(f"[drift] computation failed: {e}", file=sys.stderr)
        errors.append(f"drift: {e}")

    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
