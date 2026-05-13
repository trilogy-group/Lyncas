"""
Daily digest sender — reads all log files from the last 24h and emails a summary.
Runs once per day (e.g. 7am) via the same GitHub Actions workflow.
"""

import json
import os
import smtplib
import sys
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path

GMAIL_USER = os.environ["GMAIL_USER"]
GMAIL_APP_PASSWORD = os.environ["GMAIL_APP_PASSWORD"]  # NOT your real password — an app password
RECIPIENT = os.environ.get("DIGEST_RECIPIENT", GMAIL_USER)

LOG_DIR = Path("logs")


def collect_recent_logs(hours: int = 25) -> list[dict]:
    """Load all run-*.json files modified in the last `hours` hours."""
    if not LOG_DIR.exists():
        return []
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    logs = []
    for f in sorted(LOG_DIR.glob("run-*.json")):
        try:
            data = json.loads(f.read_text())
            started = datetime.fromisoformat(data["started_at"])
            if started >= cutoff:
                logs.append(data)
        except Exception as e:
            print(f"Could not parse {f}: {e}", file=sys.stderr)
    return logs


def build_digest(logs: list[dict]) -> tuple[str, str]:
    """Return (subject, body) for the digest email."""
    all_reviews = [r for log in logs for r in log["reviews"]]
    all_errors = [e for log in logs for e in log["errors"]]
    closed_prs = [r for r in all_reviews if r.get("action") == "closed"]

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    if not all_reviews and not all_errors:
        subject = f"[Night-pr-reviewer] {today} — nothing to review"
        body = (
            f"Daily digest for {today}\n\n"
            f"No new PRs to review in the last 24h across your watched repos.\n\n"
            f"Runs in window: {len(logs)}\n"
        )
        return subject, body

    high_sev = sum(r.get("bug_count", 0) for r in all_reviews)
    close_tag = f" — 🚫 {len(closed_prs)} AUTO-CLOSED" if closed_prs else ""
    subject = f"[Night-pr-reviewer] {today} — {len(all_reviews)} review(s), {high_sev} issue(s){close_tag}"

    lines = [
        f"Daily digest for {today}",
        f"Runs in window: {len(logs)}",
        f"PRs reviewed: {len(all_reviews)}",
        f"PRs auto-closed: {len(closed_prs)}",
        f"Errors: {len(all_errors)}",
        "",
    ]

    # AUDIT SECTION FIRST — closed PRs need your immediate attention
    if closed_prs:
        lines += [
            "=" * 60,
            "🚫 AUTO-CLOSED PRs — REVIEW THESE FIRST",
            "=" * 60,
            "",
            "These PRs were closed automatically. If any close looks wrong,",
            "reopen the PR on GitHub and audit the prompt/thresholds.",
            "",
        ]
        for r in closed_prs:
            lines += [
                f"❗ {r['pr']}  [severity {r.get('severity_score', '?')}/10]",
                f"  Title: {r['title']}",
                f"  Summary: {r['summary']}",
                f"  Bugs flagged: {r['bug_count']}",
                f"  Link: {r['url']}",
                "",
            ]

    lines += [
        "=" * 60,
        "ALL REVIEWS",
        "=" * 60,
        "",
    ]

    for r in all_reviews:
        verdict_label = {"approve": "✅ APPROVE", "request_changes": "🔴 CHANGES", "comment": "💬 COMMENT"}.get(
            r["verdict"], r["verdict"].upper()
        )
        action_tag = " [CLOSED]" if r.get("action") == "closed" else ""
        lines += [
            f"{verdict_label}{action_tag}  [{r['confidence']} conf, sev {r.get('severity_score', '?')}/10]  {r['pr']}",
            f"  Title: {r['title']}",
            f"  Summary: {r['summary']}",
            f"  Bugs flagged: {r['bug_count']}",
            f"  Tokens: {r['input_tokens']} in / {r['output_tokens']} out",
            f"  Link: {r['url']}",
            "",
        ]

    if all_errors:
        lines += ["", "=" * 60, "ERRORS", "=" * 60, ""]
        for e in all_errors:
            lines.append(f"- {e.get('pr', e.get('repo', '?'))}: {e['error']}")

    lines += ["", "--", "Sent by night-pr-reviewer running in GitHub Actions."]
    return subject, "\n".join(lines)


def send_email(subject: str, body: str) -> None:
    msg = EmailMessage()
    msg["From"] = GMAIL_USER
    msg["To"] = RECIPIENT
    msg["Subject"] = subject
    msg.set_content(body)

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as s:
        s.login(GMAIL_USER, GMAIL_APP_PASSWORD)
        s.send_message(msg)


def main() -> int:
    logs = collect_recent_logs(hours=25)
    subject, body = build_digest(logs)
    print(f"Subject: {subject}")
    print(f"Body:\n{body}")
    send_email(subject, body)
    print(f"✅ Sent digest to {RECIPIENT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
