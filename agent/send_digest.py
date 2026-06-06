"""
Daily digest sender — reads undigested PR reviews from Supabase and emails a
summary. After a successful send, records the digest in the `digests` table
and stamps `digested_at` on each included review. Runs daily at 07:00 UTC
(and on every workflow_dispatch trigger) via the same GitHub Actions workflow
as pr_reviewer.py.
"""

import html
import os
import smtplib
import sys
from datetime import datetime, timezone
from email.message import EmailMessage

from supabase import Client, create_client

GMAIL_USER = os.environ["GMAIL_USER"]
GMAIL_APP_PASSWORD = os.environ["GMAIL_APP_PASSWORD"]  # NOT your real password — an app password
RECIPIENT = os.environ.get("DIGEST_RECIPIENT", GMAIL_USER)

# Cron expression of the daily proof-of-life run. Detected via the
# GITHUB_EVENT_SCHEDULE env var (set in the workflow). On the daily run we
# still send an "all quiet" email even with zero undigested reviews; on any
# other trigger with zero content, we skip the email entirely.
DAILY_SCHEDULE = "0 7 * * *"

# --- Pricing (Phase 3) -----------------------------------------------------
# Per 1M tokens, in USD. Same numbers as agent/pr_reviewer.py — duplicated
# rather than imported to keep send_digest.py independent of pr_reviewer.py's
# Anthropic-client setup (which requires ANTHROPIC_API_KEY at import time).
MODEL_PRICING_USD_PER_M_TOKENS = {
    "claude-opus-4-5":   {"input": 15.0, "output": 75.0},
    "claude-sonnet-4-5": {"input": 3.0,  "output": 15.0},
}
# Fallback model used when a row predates the Phase 3 `model` column.
# Phase 1 made Opus the production model, so historical rows almost always
# used Opus — this matches that assumption.
FALLBACK_MODEL = "claude-opus-4-5"


def compute_cost_usd(model: str | None, input_tokens, output_tokens) -> float:
    """Convert token counts into USD using MODEL_PRICING_USD_PER_M_TOKENS.

    Returns 0.0 when the model isn't priced — better to render `$0.000` than
    to crash a digest send on an unfamiliar model string."""
    rates = MODEL_PRICING_USD_PER_M_TOKENS.get(model or FALLBACK_MODEL)
    if not rates:
        return 0.0
    in_t = input_tokens or 0
    out_t = output_tokens or 0
    return (in_t * rates["input"] + out_t * rates["output"]) / 1_000_000.0


# --- Supabase state -------------------------------------------------------
# Required: the digest is a view over `reviews` + `digests` now. If
# credentials are missing we warn and exit cleanly rather than send a
# malformed / empty email built on no data.

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")

supabase: Client | None = None
if SUPABASE_URL and SUPABASE_SERVICE_KEY:
    try:
        supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    except Exception as e:
        print(f"[ERROR] Failed to initialize Supabase client: {e}", file=sys.stderr)


def collect_undigested_reviews(user_id: str | None = None) -> list[dict] | None:
    """Return all `reviews` rows where digested_at IS NULL, ordered by
    severity_score desc so the worst PRs naturally end up at the top of the
    email. Returns None on query failure so the caller can distinguish
    "DB down" from "zero undigested rows".

    When `user_id` is provided, only that user's reviews are returned —
    the multi-tenant SaaS path uses this to fan out one digest per user.
    Legacy single-tenant callers pass None and get every undigested row
    (including SaaS rows that may also be digested separately later)."""
    if supabase is None:
        return None
    try:
        q = (
            supabase.table("reviews")
            .select("*")
            .is_("digested_at", "null")
        )
        if user_id:
            q = q.eq("user_id", user_id)
        resp = q.order("severity_score", desc=True).execute()
        return resp.data or []
    except Exception as e:
        print(f"[ERROR] Could not query undigested reviews: {e}", file=sys.stderr)
        return None


# --- Multi-tenant recipients --------------------------------------------
# Each digest run fans out: one email per (user_id, email) pair from
# watched_repos joined with auth.users / user_profiles. The legacy
# DIGEST_RECIPIENT env var still works as a fallback (returned as a single
# {user_id: None, email: <env>} entry) so existing single-tenant deploys
# don't need new config.

def _get_user_email(user_id: str) -> str | None:
    """Best effort lookup of a user's preferred digest email.

    Resolution order:
      1. user_profiles.digest_email — only when digest_email_verified is
         true (otherwise we don't trust the address).
      2. auth.users.email — the address the user signed in with. Fetched
         via Supabase's admin auth API (service-role required, which the
         agent already has).
    Returns None if neither yields a usable address (the digest for that
    user is then skipped with a logged WARN — better than silently emailing
    the wrong inbox)."""
    if supabase is None:
        return None

    try:
        prof_resp = (
            supabase.table("user_profiles")
            .select("digest_email, digest_email_verified")
            .eq("id", user_id)
            .maybe_single()
            .execute()
        )
        prof = getattr(prof_resp, "data", None) or {}
    except Exception:
        prof = {}

    if prof.get("digest_email") and prof.get("digest_email_verified"):
        return str(prof["digest_email"]).strip() or None

    try:
        user_resp = supabase.auth.admin.get_user_by_id(user_id)
        user = getattr(user_resp, "user", None) or getattr(user_resp, "data", None)
        if user is None:
            return None
        email = getattr(user, "email", None) or (
            isinstance(user, dict) and user.get("email")
        )
        if email:
            return str(email).strip()
    except Exception as e:
        print(
            f"[WARN] could not look up auth.users email for {user_id}: {e}",
            file=sys.stderr,
        )
    return None


def get_digest_recipients() -> list[dict]:
    """Return [{user_id, email}, ...] — one entry per user with at least
    one enabled watched_repos row. Empty list when no SaaS users exist
    yet; the caller falls back to the legacy DIGEST_RECIPIENT path."""
    if supabase is None:
        return []
    try:
        resp = (
            supabase.table("watched_repos")
            .select("user_id")
            .eq("enabled", True)
            .execute()
        )
    except Exception as e:
        print(
            f"[WARN] could not query watched_repos for digest recipients: {e}",
            file=sys.stderr,
        )
        return []
    rows = resp.data or []
    seen: set[str] = set()
    out: list[dict] = []
    for r in rows:
        uid = r.get("user_id")
        if not uid or uid in seen:
            continue
        seen.add(uid)
        email = _get_user_email(uid)
        if not email:
            print(
                f"[WARN] skipping digest for user_id={uid} — no email on "
                f"file (set digest_email in /dashboard/settings or sign "
                f"in with an email-bearing provider)",
                file=sys.stderr,
            )
            continue
        out.append({"user_id": uid, "email": email})
    return out


def record_digest_sent(
    *,
    review_ids: list[str],
    review_count: int,
    closed_count: int,
    subject: str,
) -> None:
    """Insert one row into `digests`. Raises on failure (caller decides)."""
    if supabase is None:
        return
    trigger_source = (
        "schedule"
        if os.environ.get("GITHUB_EVENT_SCHEDULE")
        else "workflow_dispatch"
    )
    supabase.table("digests").insert(
        {
            "review_ids": review_ids,
            "review_count": review_count,
            "closed_count": closed_count,
            "subject": subject,
            "trigger_source": trigger_source,
        }
    ).execute()


def mark_reviews_digested(review_ids: list[str]) -> None:
    """Stamp digested_at on each review just sent. No-op for empty input."""
    if supabase is None or not review_ids:
        return
    supabase.table("reviews").update(
        {"digested_at": datetime.now(timezone.utc).isoformat()}
    ).in_("id", review_ids).execute()


def _adapt_review(row: dict) -> dict:
    """Map a Supabase `reviews` row to the field names the renderer expects.
    The renderer is preserved as-is; this is a minimal name-only adapter."""
    return {
        **row,
        "pr": f"{row['repo']}#{row['pr_number']}",
        "title": row.get("pr_title", ""),
        "url": row.get("pr_url", "#"),
    }

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
# Instrument Serif (Google Fonts, italic weight 400) leads the serif stack;
# every FONT_SERIF use in this file is paired with `font-style:italic`, and
# Instrument Serif has a particularly elegant italic that matches the
# magazine-style display feel we want. Fallbacks are progressively safer:
# Cormorant Garamond is another web-font option some clients may have
# loaded elsewhere, then Georgia / Iowan / Charter cover system fallbacks
# for the (many) email clients that strip external <link> stylesheets.
FONT_SERIF = "'Instrument Serif', 'Cormorant Garamond', Georgia, 'Iowan Old Style', 'Charter', serif"
FONT_SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"


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

    total_bugs = sum((r.get("bug_count") or 0) for r in all_reviews)
    total_cost = sum(
        compute_cost_usd(r.get("model"), r.get("input_tokens"), r.get("output_tokens"))
        for r in all_reviews
    )

    lines = [
        f"Daily digest for {today}",
        f"Runs in window: {len(logs)}",
        f"PRs reviewed: {len(all_reviews)}",
        f"PRs auto-closed: {len(closed_prs)}",
        f"Bugs flagged: {total_bugs}",
        f"Total cost: ${total_cost:.3f}",
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
    lines += ["", "--", "Sent by Lyncas running in GitHub Actions."]
    return "\n".join(lines)


# ---- HTML helpers ----------------------------------------------------------
def _render_header(today: str, n_reviews: int, n_closed: int) -> str:
    sub = "your overnight code-review digest"
    return f"""
<tr><td style="padding:28px 24px 8px 24px;">
  <div style="font-family:{FONT_SANS};font-size:22px;font-weight:600;color:{COLOR_TEXT};letter-spacing:-0.01em;">
    Lyncas
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


def _render_summary_panel(
    n_reviews: int, n_closed: int, n_bugs: int, total_cost_usd: float
) -> str:
    """Phase 3: 4-stat panel at the top of the digest. Matches the labels
    'total reviews / total closed / total bugs flagged / total cost'
    requested in IMPROVEMENTS_v2.md."""
    cost_str = f"${total_cost_usd:.2f}" if total_cost_usd >= 0.01 else f"${total_cost_usd:.3f}"
    return f"""
<tr><td style="padding:8px 24px 4px 24px;">
  <div style="font-family:{FONT_SANS};font-size:12px;font-weight:600;color:{COLOR_MUTED};text-transform:uppercase;letter-spacing:0.08em;">
    Summary (this digest)
  </div>
</td></tr>
<tr><td style="padding:8px 24px 16px 24px;">
  <table width="100%" cellpadding="0" cellspacing="6" border="0" role="presentation">
    <tr>
      {_stat_cell("Reviews", str(n_reviews))}
      {_stat_cell("Auto-closed", str(n_closed), SEV_CRITICAL if n_closed else COLOR_TEXT)}
      {_stat_cell("Bugs flagged", str(n_bugs), SEV_MODERATE if n_bugs else COLOR_TEXT)}
      {_stat_cell("Total cost", cost_str)}
    </tr>
  </table>
</td></tr>
"""


def _pick_top_bug(bugs) -> dict | None:
    """Return the most severe bug from the list (critical > high > medium >
    low > unknown). Returns None for an empty / non-list value."""
    if not isinstance(bugs, list) or not bugs:
        return None
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3}

    def _key(b):
        sev = (b.get("severity") if isinstance(b, dict) else "") or ""
        return order.get(sev.lower(), 99)

    return sorted((b for b in bugs if isinstance(b, dict)), key=_key)[:1][0] if any(
        isinstance(b, dict) for b in bugs
    ) else None


def _extract_code_snippet(suggestion) -> tuple[str, str]:
    """Return ``(language, code)`` extracted from a fenced markdown block in
    ``suggestion``. If no fence is found, returns ``("", "")`` and the caller
    falls back to plain-text rendering."""
    if not isinstance(suggestion, str) or "```" not in suggestion:
        return "", ""
    # Take everything between the first pair of triple backticks.
    after_first = suggestion.split("```", 1)[1]
    if "```" not in after_first:
        return "", ""
    inside = after_first.split("```", 1)[0]
    # First line may be a language tag (e.g. "python\n...").
    first_nl = inside.find("\n")
    if first_nl == -1:
        return "", inside.strip()
    maybe_lang = inside[:first_nl].strip()
    body = inside[first_nl + 1:]
    # Treat short, alpha-only first lines as language tags; everything else
    # is part of the code.
    if maybe_lang and maybe_lang.replace("-", "").replace("+", "").isalnum() and len(maybe_lang) <= 20:
        return maybe_lang, body.rstrip()
    return "", inside.rstrip()


def _render_top_bug(bugs) -> str:
    """Render the top bug's issue / impact / suggested code snippet as a
    small embedded panel inside the PR card. Empty string when no bugs."""
    bug = _pick_top_bug(bugs)
    if not bug:
        return ""

    sev = (bug.get("severity") or "").lower()
    sev_color = {
        "critical": SEV_CRITICAL,
        "high":     SEV_CRITICAL,
        "medium":   SEV_SERIOUS,
        "low":      SEV_MODERATE,
    }.get(sev, COLOR_MUTED)

    issue = bug.get("issue") or ""
    impact = bug.get("impact") or ""
    file_ = bug.get("file") or ""
    line = bug.get("line_hint")
    location = file_ + (f":{line}" if line not in (None, "", "null") else "")

    lang, code = _extract_code_snippet(bug.get("suggestion") or "")
    snippet_html = ""
    if code:
        snippet_html = f"""
      <div style="font-family:{FONT_MONO};font-size:11px;color:{COLOR_MUTED};text-transform:uppercase;letter-spacing:0.06em;margin-top:10px;margin-bottom:4px;">
        Suggested fix{f' · {_e(lang)}' if lang else ''}
      </div>
      <pre style="margin:0;padding:10px 12px;background:{COLOR_BG};border:1px solid {COLOR_BORDER};border-radius:4px;overflow-x:auto;font-family:{FONT_MONO};font-size:11.5px;line-height:1.5;color:{COLOR_TEXT};"><code>{_e(code)}</code></pre>
"""

    impact_html = ""
    if impact:
        impact_html = f"""
      <div style="font-family:{FONT_SANS};font-size:12px;color:{COLOR_MUTED};line-height:1.55;margin-top:8px;">
        <span style="font-weight:600;color:{COLOR_TEXT};">Impact:</span> {_e(impact)}
      </div>
"""

    location_html = ""
    if location:
        location_html = f'<span style="font-family:{FONT_MONO};font-size:11px;color:{COLOR_MUTED};margin-left:8px;">{_e(location)}</span>'

    return f"""
    <div style="margin:8px 0 4px 0;padding:12px 14px;background:{COLOR_BG};border-left:3px solid {sev_color};border-radius:4px;">
      <div style="font-family:{FONT_SANS};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:{sev_color};">
        Top bug{f' · {_e(sev)}' if sev else ''}
      </div>
      <div style="font-family:{FONT_SANS};font-size:13px;color:{COLOR_TEXT};line-height:1.55;margin-top:4px;">
        {_e(issue)}{location_html}
      </div>
      {impact_html}
      {snippet_html}
    </div>
"""


def _render_context_badge(used) -> str:
    """Phase 3 'Repo context used' badge — yes/no."""
    is_used = bool(used)
    bg = SEV_CLEAN if is_used else COLOR_BG
    fg = "#ffffff" if is_used else COLOR_MUTED
    border = "" if is_used else f"border:1px solid {COLOR_BORDER};"
    label = "context: yes" if is_used else "context: no"
    return (
        f'<span style="display:inline-block;margin-left:6px;padding:4px 10px;'
        f'border-radius:4px;background:{bg};color:{fg};font-family:{FONT_MONO};'
        f'font-size:11px;font-weight:500;{border}">{label}</span>'
    )


def _render_pr_card(r: dict, in_closed_section: bool = False) -> str:
    sev = r.get("severity_score", "?")
    sev_color = _severity_color(sev)
    verdict_color, verdict_label = _verdict_meta(r.get("verdict", ""))
    action_tag = ""
    if r.get("action") == "closed" and not in_closed_section:
        action_tag = f'<span style="display:inline-block;margin-left:6px;padding:3px 8px;border-radius:4px;background:{SEV_CRITICAL};color:#fff;font-family:{FONT_MONO};font-size:11px;font-weight:600;">CLOSED</span>'

    conf = r.get("confidence", "?")
    bg = CLOSED_BG if in_closed_section else COLOR_CARD

    # Phase 3 extras
    top_bug_html = _render_top_bug(r.get("bugs"))
    context_badge = _render_context_badge(r.get("repo_context_used"))
    cost = compute_cost_usd(
        r.get("model"), r.get("input_tokens"), r.get("output_tokens")
    )
    cost_str = f"${cost:.3f}"

    return f"""
<tr><td style="padding:8px 24px;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background:{bg};border:1px solid {COLOR_BORDER};border-left:4px solid {sev_color};border-radius:8px;">
    <tr><td style="padding:20px 22px;">
      <div style="margin-bottom:10px;">
        <span style="display:inline-block;padding:4px 10px;border-radius:4px;background:{verdict_color};color:#fff;font-family:{FONT_MONO};font-size:11px;font-weight:600;letter-spacing:0.02em;">{verdict_label}</span>
        <span style="display:inline-block;margin-left:6px;padding:4px 10px;border-radius:4px;background:{sev_color};color:#fff;font-family:{FONT_MONO};font-size:11px;font-weight:600;">sev {_e(sev)}/10</span>
        <span style="display:inline-block;margin-left:6px;padding:4px 10px;border-radius:4px;background:{COLOR_BG};color:{COLOR_MUTED};font-family:{FONT_MONO};font-size:11px;font-weight:500;border:1px solid {COLOR_BORDER};">{_e(conf)} conf</span>
        {context_badge}
        {action_tag}
      </div>
      <div style="font-family:{FONT_SANS};font-size:15px;font-weight:600;color:{COLOR_TEXT};line-height:1.4;margin-bottom:6px;">
        {_e(r.get('title', ''))}
      </div>
      <div style="font-family:{FONT_SANS};font-size:13px;color:{COLOR_MUTED};line-height:1.55;margin-bottom:6px;">
        {_e(r.get('summary', ''))}
      </div>
      {top_bug_html}
      <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-top:14px;">
        <tr>
          <td align="left" style="font-family:{FONT_MONO};font-size:11px;color:{COLOR_MUTED};">
            <span style="color:{COLOR_TEXT};">{_e(r.get('pr', ''))}</span>
            &nbsp;·&nbsp; bugs: <span style="color:{COLOR_TEXT};">{_e(r.get('bug_count', 0))}</span>
            &nbsp;·&nbsp; tok: <span style="color:{COLOR_TEXT};">{_e(r.get('input_tokens', 0))}</span>↓ / <span style="color:{COLOR_TEXT};">{_e(r.get('output_tokens', 0))}</span>↑
            &nbsp;·&nbsp; cost: <span style="color:{COLOR_TEXT};">{cost_str}</span>
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
    Sent by Lyncas · running autonomously in GitHub Actions
    <br><span style="font-family:{FONT_MONO};font-style:normal;">{_e(today)}</span>
  </div>
</td></tr>
"""


def _render_empty_state(today: str) -> str:
    return f"""<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
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

    # Phase 3: digest-wide summary stats.
    total_bugs = sum((r.get("bug_count") or 0) for r in all_reviews)
    total_cost = sum(
        compute_cost_usd(r.get("model"), r.get("input_tokens"), r.get("output_tokens"))
        for r in all_reviews
    )

    body = (
        _render_header(today, len(all_reviews), len(closed_prs))
        + _render_summary_panel(
            len(all_reviews), len(closed_prs), total_bugs, total_cost
        )
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
<title>Lyncas Digest</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
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


def _pluralize(n: int, singular: str, plural: str | None = None) -> str:
    if n == 1:
        return f"1 {singular}"
    return f"{n} {plural or singular + 's'}"


def _build_subject(all_reviews: list[dict], all_errors: list[dict], closed_prs: list[dict]) -> str:
    n_reviews = len(all_reviews)
    n_closed = len(closed_prs)
    n_errors = len(all_errors)
    n_bugs = sum(r.get("bug_count", 0) for r in all_reviews)

    if not all_reviews and not all_errors:
        return "🌙 Lyncas — all quiet"

    if n_closed:
        return f"🚫 Lyncas — {_pluralize(n_closed, 'auto-closed', 'auto-closed')} · {n_reviews} reviewed"

    if n_errors:
        return f"⚠️ Lyncas — {n_reviews} reviewed · {_pluralize(n_errors, 'error')}"

    if n_bugs:
        return f"🌙 Lyncas — {_pluralize(n_reviews, 'PR')} reviewed · {_pluralize(n_bugs, 'issue')} to look at"

    return f"🌙 Lyncas — {_pluralize(n_reviews, 'PR')} reviewed, all clean"


def build_digest(reviews: list[dict]) -> tuple[str, str, str]:
    """Return (subject, text_body, html_body) for the digest email.

    `reviews` is the list of adapter-shaped review dicts (one per Supabase
    row), already ordered by severity desc. Errors are no longer surfaced
    in the email — they live in `runs.errors` and will surface on the
    dashboard (Phase 4)."""
    all_reviews = reviews
    all_errors: list[dict] = []
    closed_prs = [r for r in all_reviews if r.get("action") == "closed"]
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # The renderer's "Runs in window" stat was derived from log-file count.
    # We pass an empty list so that counter reads as 0 — accurate per-run
    # observability lives on the dashboard now.
    logs: list[dict] = []

    subject = _build_subject(all_reviews, all_errors, closed_prs)

    text_body = _build_text(logs, all_reviews, all_errors, closed_prs, today)
    html_body = _render_html(logs, all_reviews, all_errors, closed_prs, today)
    return subject, text_body, html_body


def send_email(
    subject: str, text_body: str, html_body: str, to: str | None = None
) -> None:
    """Send the digest. `to` overrides the env-default RECIPIENT — the
    multi-tenant fan-out passes the per-user address here, single-tenant
    callers omit it."""
    msg = EmailMessage()
    msg["From"] = GMAIL_USER
    msg["To"] = to or RECIPIENT
    msg["Subject"] = subject
    msg.set_content(text_body)
    msg.add_alternative(html_body, subtype="html")

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as s:
        s.login(GMAIL_USER, GMAIL_APP_PASSWORD)
        s.send_message(msg)


def _send_one_digest(
    *,
    user_id: str | None,
    recipient_email: str,
    is_daily: bool,
) -> tuple[bool, int]:
    """Build and send a digest for one recipient. Returns (sent, n_reviews).
    `sent=False` means we deliberately skipped (empty + non-daily); errors
    bubble up so main() can return non-zero for CI visibility."""
    undigested = collect_undigested_reviews(user_id=user_id)
    if undigested is None:
        # Distinct from empty: a hard query failure. Don't send a partial
        # / fabricated digest.
        raise RuntimeError("undigested-query-failed")

    if not undigested and not is_daily:
        scope = f"user_id={user_id}" if user_id else "global"
        print(f"no new reviews since last digest ({scope}), skipping email")
        return False, 0

    review_ids = [r["id"] for r in undigested]
    closed_count = sum(1 for r in undigested if r.get("action") == "closed")
    review_dicts = [_adapt_review(r) for r in undigested]

    subject, text_body, html_body = build_digest(review_dicts)
    print(f"[{recipient_email}] Subject: {subject}")
    send_email(subject, text_body, html_body, to=recipient_email)
    print(f"✅ Sent digest to {recipient_email} ({len(undigested)} reviews)")

    # Order matters: record the digest first, then mark its reviews. If the
    # update fails, the digests row still exists for manual reconciliation;
    # the reverse order would leave reviews silently digested with no record.
    if review_ids:
        record_digest_sent(
            review_ids=review_ids,
            review_count=len(undigested),
            closed_count=closed_count,
            subject=subject,
        )
        mark_reviews_digested(review_ids)
    return True, len(undigested)


def main() -> int:
    if supabase is None:
        print(
            "[ERROR] SUPABASE_URL or SUPABASE_SERVICE_KEY is unset — "
            "cannot build digest without DB access; skipping",
            file=sys.stderr,
        )
        return 1

    is_daily = os.environ.get("GITHUB_EVENT_SCHEDULE") == DAILY_SCHEDULE
    recipients = get_digest_recipients()

    # Backward-compat path: no SaaS users yet → send one combined digest
    # to the env-configured RECIPIENT, exactly as v1 did. The legacy
    # collect_undigested_reviews() (no user_id filter) picks up
    # *everything* including v1 rows whose user_id is NULL.
    if not recipients:
        try:
            sent, _ = _send_one_digest(
                user_id=None,
                recipient_email=RECIPIENT,
                is_daily=is_daily,
            )
        except RuntimeError as e:
            print(f"[ERROR] {e}; refusing to send a partial digest", file=sys.stderr)
            return 1
        except Exception as e:
            print(
                f"[ERROR] Could not send digest: {e} — reviews left "
                "undigested; next run will re-send",
                file=sys.stderr,
            )
            return 1
        return 0 if sent or not is_daily else 0

    # Multi-tenant path: one email per user. Failures are per-user — a
    # send error for one user doesn't block the others. We return non-zero
    # at the end iff at least one user failed.
    any_failed = False
    for rcpt in recipients:
        try:
            _send_one_digest(
                user_id=rcpt["user_id"],
                recipient_email=rcpt["email"],
                is_daily=is_daily,
            )
        except Exception as e:
            any_failed = True
            print(
                f"[ERROR] digest for user_id={rcpt.get('user_id')} "
                f"({rcpt.get('email')}) failed: {e}",
                file=sys.stderr,
            )
    return 1 if any_failed else 0


if __name__ == "__main__":
    sys.exit(main())
