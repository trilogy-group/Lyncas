"""
Daily digest sender — reads all log files from the last 24h and emails a summary.
Runs once per day (e.g. 7am) via the same GitHub Actions workflow.
"""

import html
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

# ---- Palette ---------------------------------------------------------------
COLOR_BG = "#fafaf9"
COLOR_CARD = "#ffffff"
COLOR_BORDER = "#e7e5e4"
COLOR_TEXT = "#1c1917"
COLOR_MUTED = "#57534e"
COLOR_ACCENT = "#4338ca"

SEV_CRITICAL = "#dc2626"
SEV_SERIOUS = "#ea580c"
SEV_MODERATE = "#ca8a04"
SEV_CLEAN = "#16a34a"

VERDICT_APPROVE = "#16a34a"
VERDICT_CHANGES = "#dc2626"
VERDICT_COMMENT = "#2563eb"

CLOSED_BG = "#fef2f2"

FONT_MONO = "'JetBrains Mono', 'SF Mono', 'Menlo', 'Consolas', monospace"
FONT_SERIF = "Georgia, 'Iowan Old Style', 'Charter', serif"
FONT_SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"


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


def _severity_color(score) -> str:
    try:
        s = int(score)
    except (TypeError, ValueError):
        return COLOR_MUTED
    if s >= 9:
        return SEV_CRITICAL
    if s >= 7:
        return SEV_SERIOUS
    if s >= 4:
        return SEV_MODERATE
    return SEV_CLEAN


def _verdict_meta(verdict: str) -> tuple[str, str]:
    return {
        "approve": (VERDICT_APPROVE, "✓ approve"),
        "request_changes": (VERDICT_CHANGES, "✕ request changes"),
        "comment": (VERDICT_COMMENT, "💬 comment"),
    }.get(verdict, (COLOR_MUTED, html.escape(verdict)))


def _e(v) -> str:
    return html.escape(str(v))


# ---- Plain text build (fallback) ------------------------------------------
def _build_text(logs, all_reviews, all_errors, closed_prs, today) -> str:
    if not all_reviews and not all_errors:
        return (
            f"Daily digest for {today}\n\n"
            f"No new PRs to review in the last 24h across your watched repos.\n\n"
            f"Runs in window: {len(logs)}\n"
        )

    lines = [
        f"Daily digest for {today}",
        f"Runs in window: {len(logs)}",
        f"PRs reviewed: {len(all_reviews)}",
        f"PRs auto-closed: {len(closed_prs)}",
        f"Errors: {len(all_errors)}",
        "",
    ]
    if closed_prs:
        lines += ["=" * 60, "🚫 AUTO-CLOSED PRs — REVIEW THESE FIRST", "=" * 60, ""]
        for r in closed_prs:
            lines += [
                f"❗ {r['pr']}  [severity {r.get('severity_score', '?')}/10]",
                f"  Title: {r['title']}",
                f"  Summary: {r['summary']}",
                f"  Bugs flagged: {r['bug_count']}",
                f"  Link: {r['url']}",
                "",
            ]
    lines += ["=" * 60, "ALL REVIEWS", "=" * 60, ""]
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
    return "\n".join(lines)


# ---- HTML helpers ----------------------------------------------------------
def _render_header(today: str, n_reviews: int, n_closed: int) -> str:
    sub = "your overnight code-review digest"
    return f"""
<tr><td style="padding:28px 24px 8px 24px;">
  <div style="font-family:{FONT_SANS};font-size:22px;font-weight:600;color:{COLOR_TEXT};letter-spacing:-0.01em;">
    Night PR Reviewer
  </div>
  <div style="font-family:{FONT_SERIF};font-style:italic;font-size:14px;color:{COLOR_MUTED};margin-top:4px;">
    {_e(sub)} · <span style="font-family:{FONT_MONO};font-style:normal;">{_e(today)}</span>
  </div>
</td></tr>
"""


def _stat_cell(label: str, value: str, accent: str = COLOR_TEXT) -> str:
    return f"""
<td width="25%" align="center" style="padding:14px 8px;border:1px solid {COLOR_BORDER};background:{COLOR_CARD};border-radius:6px;">
  <div style="font-family:{FONT_MONO};font-size:22px;font-weight:600;color:{accent};">{_e(value)}</div>
  <div style="font-family:{FONT_MONO};font-size:11px;color:{COLOR_MUTED};text-transform:uppercase;letter-spacing:0.06em;margin-top:4px;">{_e(label)}</div>
</td>
"""


def _render_stats(n_runs: int, n_reviews: int, n_closed: int, n_errors: int) -> str:
    return f"""
<tr><td style="padding:16px 24px;">
  <table width="100%" cellpadding="0" cellspacing="6" border="0" role="presentation">
    <tr>
      {_stat_cell("Runs", str(n_runs))}
      {_stat_cell("Reviewed", str(n_reviews))}
      {_stat_cell("Auto-closed", str(n_closed), SEV_CRITICAL if n_closed else COLOR_TEXT)}
      {_stat_cell("Errors", str(n_errors), SEV_SERIOUS if n_errors else COLOR_TEXT)}
    </tr>
  </table>
</td></tr>
"""


def _render_pr_card(r: dict, in_closed_section: bool = False) -> str:
    sev = r.get("severity_score", "?")
    sev_color = _severity_color(sev)
    verdict_color, verdict_label = _verdict_meta(r.get("verdict", ""))
    action_tag = ""
    if r.get("action") == "closed" and not in_closed_section:
        action_tag = f'<span style="display:inline-block;margin-left:6px;padding:3px 8px;border-radius:4px;background:{SEV_CRITICAL};color:#fff;font-family:{FONT_MONO};font-size:11px;font-weight:600;">CLOSED</span>'

    conf = r.get("confidence", "?")
    bg = CLOSED_BG if in_closed_section else COLOR_CARD

    return f"""
<tr><td style="padding:8px 24px;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background:{bg};border:1px solid {COLOR_BORDER};border-left:4px solid {sev_color};border-radius:8px;">
    <tr><td style="padding:20px 22px;">
      <div style="margin-bottom:10px;">
        <span style="display:inline-block;padding:4px 10px;border-radius:4px;background:{verdict_color};color:#fff;font-family:{FONT_MONO};font-size:11px;font-weight:600;letter-spacing:0.02em;">{verdict_label}</span>
        <span style="display:inline-block;margin-left:6px;padding:4px 10px;border-radius:4px;background:{sev_color};color:#fff;font-family:{FONT_MONO};font-size:11px;font-weight:600;">sev {_e(sev)}/10</span>
        <span style="display:inline-block;margin-left:6px;padding:4px 10px;border-radius:4px;background:{COLOR_BG};color:{COLOR_MUTED};font-family:{FONT_MONO};font-size:11px;font-weight:500;border:1px solid {COLOR_BORDER};">{_e(conf)} conf</span>
        {action_tag}
      </div>
      <div style="font-family:{FONT_SANS};font-size:15px;font-weight:600;color:{COLOR_TEXT};line-height:1.4;margin-bottom:6px;">
        {_e(r.get('title', ''))}
      </div>
      <div style="font-family:{FONT_SANS};font-size:13px;color:{COLOR_MUTED};line-height:1.55;margin-bottom:14px;">
        {_e(r.get('summary', ''))}
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
        <tr>
          <td align="left" style="font-family:{FONT_MONO};font-size:11px;color:{COLOR_MUTED};">
            <span style="color:{COLOR_TEXT};">{_e(r.get('pr', ''))}</span>
            &nbsp;·&nbsp; bugs: <span style="color:{COLOR_TEXT};">{_e(r.get('bug_count', 0))}</span>
            &nbsp;·&nbsp; tok: <span style="color:{COLOR_TEXT};">{_e(r.get('input_tokens', 0))}</span>↓ / <span style="color:{COLOR_TEXT};">{_e(r.get('output_tokens', 0))}</span>↑
          </td>
          <td align="right" style="font-family:{FONT_MONO};font-size:12px;">
            <a href="{_e(r.get('url', '#'))}" style="color:{COLOR_ACCENT};text-decoration:none;font-weight:500;">View on GitHub →</a>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</td></tr>
"""


def _render_closed_section(closed_prs: list[dict]) -> str:
    if not closed_prs:
        return ""
    header = f"""
<tr><td style="padding:24px 24px 4px 24px;">
  <div style="font-family:{FONT_SERIF};font-style:italic;font-size:17px;color:{SEV_CRITICAL};font-weight:600;">
    🚫 Auto-closed PRs — review these first
  </div>
  <div style="font-family:{FONT_SERIF};font-style:italic;font-size:13px;color:{COLOR_MUTED};margin-top:4px;">
    if any close looks wrong, reopen the PR on GitHub and audit the prompt
  </div>
</td></tr>
"""
    cards = "".join(_render_pr_card(r, in_closed_section=True) for r in closed_prs)
    return header + cards


def _render_reviews_section(all_reviews: list[dict]) -> str:
    if not all_reviews:
        return ""
    header = f"""
<tr><td style="padding:24px 24px 4px 24px;">
  <div style="font-family:{FONT_SANS};font-size:13px;font-weight:600;color:{COLOR_MUTED};text-transform:uppercase;letter-spacing:0.08em;">
    All reviews
  </div>
  <div style="font-family:{FONT_SERIF};font-style:italic;font-size:13px;color:{COLOR_MUTED};margin-top:2px;">
    everything Claude looked at in the last 24h
  </div>
</td></tr>
"""
    cards = "".join(_render_pr_card(r) for r in all_reviews)
    return header + cards


def _render_errors_section(errors: list[dict]) -> str:
    if not errors:
        return ""
    rows = ""
    for e in errors:
        who = e.get("pr") or e.get("repo") or "?"
        rows += f"""
<tr><td style="padding:8px 12px;font-family:{FONT_MONO};font-size:12px;color:{COLOR_TEXT};border-bottom:1px solid {COLOR_BORDER};">
  <span style="color:{SEV_CRITICAL};">●</span> <span style="color:{COLOR_MUTED};">{_e(who)}</span> — {_e(e.get('error', ''))}
</td></tr>
"""
    return f"""
<tr><td style="padding:24px 24px 4px 24px;">
  <div style="font-family:{FONT_SANS};font-size:13px;font-weight:600;color:{SEV_SERIOUS};text-transform:uppercase;letter-spacing:0.08em;">
    Errors
  </div>
</td></tr>
<tr><td style="padding:8px 24px 0 24px;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background:{COLOR_CARD};border:1px solid {COLOR_BORDER};border-radius:8px;">
    {rows}
  </table>
</td></tr>
"""


def _render_footer(today: str) -> str:
    return f"""
<tr><td style="padding:28px 24px 32px 24px;text-align:center;">
  <div style="font-family:{FONT_SERIF};font-style:italic;font-size:12px;color:{COLOR_MUTED};line-height:1.6;">
    Sent by night-pr-reviewer · running autonomously in GitHub Actions
    <br><span style="font-family:{FONT_MONO};font-style:normal;">{_e(today)}</span>
  </div>
</td></tr>
"""


def _render_empty_state(today: str) -> str:
    return f"""<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:{COLOR_BG};">
<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background:{COLOR_BG};">
  <tr><td align="center" style="padding:40px 16px;">
    <table width="640" cellpadding="0" cellspacing="0" border="0" role="presentation" style="max-width:640px;width:100%;background:{COLOR_CARD};border:1px solid {COLOR_BORDER};border-radius:8px;">
      <tr><td style="padding:48px 32px;text-align:center;">
        <div style="font-family:{FONT_SERIF};font-style:italic;font-size:18px;color:{COLOR_TEXT};line-height:1.5;">
          All quiet — no PRs to review in the last 24h
        </div>
        <div style="font-family:{FONT_MONO};font-size:12px;color:{COLOR_MUTED};margin-top:14px;">{_e(today)}</div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>"""


def _render_html(logs, all_reviews, all_errors, closed_prs, today) -> str:
    if not all_reviews and not all_errors:
        return _render_empty_state(today)

    body = (
        _render_header(today, len(all_reviews), len(closed_prs))
        + _render_stats(len(logs), len(all_reviews), len(closed_prs), len(all_errors))
        + _render_closed_section(closed_prs)
        + _render_reviews_section(all_reviews)
        + _render_errors_section(all_errors)
        + _render_footer(today)
    )

    return f"""<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>Night PR Reviewer Digest</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:{COLOR_BG};color:{COLOR_TEXT};">
<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background:{COLOR_BG};">
  <tr><td align="center" style="padding:24px 12px;">
    <table width="640" cellpadding="0" cellspacing="0" border="0" role="presentation" style="max-width:640px;width:100%;background:{COLOR_CARD};border:1px solid {COLOR_BORDER};border-radius:8px;overflow:hidden;">
      {body}
    </table>
  </td></tr>
</table>
</body></html>"""


def build_digest(logs: list[dict]) -> tuple[str, str, str]:
    """Return (subject, text_body, html_body) for the digest email."""
    all_reviews = [r for log in logs for r in log["reviews"]]
    all_errors = [e for log in logs for e in log["errors"]]
    closed_prs = [r for r in all_reviews if r.get("action") == "closed"]
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    if not all_reviews and not all_errors:
        subject = f"[Night-pr-reviewer] {today} — nothing to review"
    else:
        high_sev = sum(r.get("bug_count", 0) for r in all_reviews)
        close_tag = f" — 🚫 {len(closed_prs)} AUTO-CLOSED" if closed_prs else ""
        subject = f"[Night-pr-reviewer] {today} — {len(all_reviews)} review(s), {high_sev} issue(s){close_tag}"

    text_body = _build_text(logs, all_reviews, all_errors, closed_prs, today)
    html_body = _render_html(logs, all_reviews, all_errors, closed_prs, today)
    return subject, text_body, html_body


def send_email(subject: str, text_body: str, html_body: str) -> None:
    msg = EmailMessage()
    msg["From"] = GMAIL_USER
    msg["To"] = RECIPIENT
    msg["Subject"] = subject
    msg.set_content(text_body)
    msg.add_alternative(html_body, subtype="html")

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as s:
        s.login(GMAIL_USER, GMAIL_APP_PASSWORD)
        s.send_message(msg)


def main() -> int:
    logs = collect_recent_logs(hours=25)
    subject, text_body, html_body = build_digest(logs)
    print(f"Subject: {subject}")
    print(f"Text body:\n{text_body}")
    send_email(subject, text_body, html_body)
    print(f"✅ Sent digest to {RECIPIENT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
