# Skill: Review & digest format reference

Exact markdown / HTML formats the agent emits. Two surfaces:

1. **GitHub PR comment** — markdown, built by
   `format_review_comment(review)` (or `format_close_comment(review)`
   for the auto-close path) in `agent/pr_reviewer.py`.
2. **Email digest** — HTML + plain-text fallback, built by
   `build_digest(reviews)` → `_render_html(...)` / `_build_text(...)`
   in `agent/send_digest.py`.

Both formats must stay consistent because the dashboard's color
palette and badge labels (`dashboard/lib/design.ts`) mirror them.

---

## GitHub PR review comment

Posted via `post_review_comment(repo, pr_number, body)` to
`POST /repos/{repo}/issues/{pr_number}/comments`. The first line is
the idempotency marker — invisible HTML comment.

### Skeleton (Phase 3 layout)

```markdown
<!-- lyncas:v1 -->
## 🌙 Lyncas

**Verdict:** ✅ APPROVE
**Severity:** 4/10 · **Confidence:** high

> [one-sentence summary of the PR's purpose and overall quality]

---

### 🐛 Bugs (2)

#### 🔴 [issue title] — `path/to/file.py:42`

**Impact:** [impact sentence]

**Suggested fix:**

```python
# fenced code snippet from suggestion field
```

_Reference:_ https://example.com/spec

---

#### 🟠 [next bug title] — `other/file.ts`

...

### ⚠️ Concerns (1)

- [concern issue] — `path:line` _[medium]_
  - **Impact:** [impact]
  - **Suggestion:** [fix]

### ❓ Questions (1)

- [question text]

### ✅ Praise (1)

- [praise text]

---
*Reviewed by `claude-opus-4-5` · 12345 in / 678 out · $0.236*
*Repo context: cached*
```

### Field-to-renderer mapping

| Review dict field | Renderer | Notes |
|---|---|---|
| `verdict` | `VERDICT_EMOJI` + `VERDICT_LABEL` in the header | `approve` → ✅ APPROVE, `request_changes` → 🔴 REQUEST CHANGES, `comment` → 💬 COMMENT |
| `severity_score` | header line | `N/10` |
| `confidence` | header line | as-is |
| `summary` | blockquote line | trimmed |
| `bugs` | `_render_bug_section(bugs)` | severity-sorted: critical → high → medium → low → unknown |
| `concerns` | `_render_concerns_section(concerns)` | dict-shaped OR plain-string entries both supported |
| `questions` | `_render_simple_list_section("### ❓ Questions", ...)` | plain strings |
| `praise` | `_render_simple_list_section("### ✅ Praise", ...)` | plain strings |
| `_truncated` | conditional ⚠️ note before footer | only if true |
| `_model`, `_input_tokens`, `_output_tokens` | footer line | cost = tokens × pricing |
| `_fingerprint_status` | footer line | `cached` / `fresh` / `unavailable` |

### Bug severity → emoji

`SEVERITY_EMOJI` dict:

```python
SEVERITY_EMOJI = {"critical": "🔥", "high": "🔴", "medium": "🟠", "low": "🟡"}
SEVERITY_ORDER = ("critical", "high", "medium", "low")
```

Bugs with unrecognized severity render at the end with a `•`
prefix — defensive so a hallucinated severity doesn't silently drop
the bug.

### Bug location formatting

`_bug_location(bug)`:

- `file` only → `` `path/to/file.py` ``
- `file` + `line_hint` (non-null, non-empty, non-`"null"`) →
  `` `path/to/file.py:42` `` or `` `path:42-58` ``

### Footer cost

`compute_cost_usd(model, input_tokens, output_tokens)`:

```python
rates = MODEL_PRICING_USD_PER_M_TOKENS[model]   # opus: in=15, out=75; sonnet: in=3, out=15
cost = ((in_tok * rates["input"]) + (out_tok * rates["output"])) / 1_000_000
```

Formatted as `${cost:.3f}` (three decimals so sub-cent reviews
render as `$0.008` instead of `$0.00`).

---

## Auto-close comment

When `should_auto_close(review)` returns `True`, `close_pr(...)`
posts a different comment first, then patches `state=closed`.
Format from `format_close_comment(review)`:

```markdown
<!-- lyncas:closed:v1 -->
## 🚫 PR auto-closed by Lyncas

This PR was automatically closed because all three gates were met:
- Verdict: `request_changes`
- Confidence: `high`
- Severity score: **9/10** (threshold: 9)

### Why
[review.summary]

### Issues flagged
- **[CRITICAL]** `path/to/file` — [bug.issue]
- **[HIGH]** `other/file` — [bug.issue]

### Disagree?
**If you believe this close is wrong, reopen the PR with the
`Reopen pull request` button at the bottom.** The agent will not
close it again (it leaves a marker). The repo owner will review
the dispute in the morning digest.

### Recommended path forward
1. Address the issues listed above in a new commit on the same branch
2. Open a fresh PR

---
*This action was automated. LLMs can be wrong. The repo owner audits
every auto-close in the daily digest.*
```

Different marker (`CLOSE_MARKER = <!-- lyncas:closed:v1 -->`)
so re-checking detects auto-close history specifically.

---

## Email digest

Built by `build_digest(reviews) -> (subject, text_body, html_body)`.
HTML is the primary; text is the fallback `text/plain` part for
clients that strip HTML.

### Subject

`_build_subject(all_reviews, all_errors, closed_prs)`:

| Condition | Subject |
|---|---|
| `not all_reviews and not all_errors` | `🌙 Lyncas — all quiet` |
| `n_closed > 0` | `🚫 Lyncas — N auto-closed · M reviewed` |
| `n_errors > 0` | `⚠️ Lyncas — M reviewed · N errors` |
| `n_bugs > 0` | `🌙 Lyncas — M PRs reviewed · N issues to look at` |
| else | `🌙 Lyncas — M PRs reviewed, all clean` |

Pluralization is via `_pluralize(n, "singular", "plural?")`.

### HTML structure (top to bottom)

1. **Header** — `Lyncas` brand + `your overnight code-review
   digest · YYYY-MM-DD` in italicized serif. `_render_header`.
2. **Summary panel** — 4 stat tiles: Reviews / Auto-closed / Bugs
   flagged / Total cost. `_render_summary_panel`. Costs aggregate
   `compute_cost_usd(r.model, r.input_tokens, r.output_tokens)` per
   row.
3. **Runs stats** — 4 tiles: Runs / Reviewed / Auto-closed / Errors.
   `_render_stats`. ("Runs" is always 0 in the v2 digest since runs
   data lives on the dashboard now; the panel is retained for
   visual symmetry.)
4. **🚫 Auto-closed PRs section** (only if any) — header + cards
   in red. `_render_closed_section`.
5. **All reviews section** — header + one card per review.
   `_render_reviews_section`.
6. **Errors section** (only if any) — list. `_render_errors_section`.
7. **Footer** — italicized "Sent by Lyncas · running
   autonomously in GitHub Actions". `_render_footer`.

If both `all_reviews` and `all_errors` are empty, render
`_render_empty_state(today)` instead — just an italic
"All quiet — no PRs to review in the last 24h" panel.

### Per-card structure (`_render_pr_card`)

Each PR card has:

- **Left border colored by severity** (`_severity_color(score)`):
  9–10 red, 7–8 orange, 4–6 amber, 1–3 green, unknown muted.
- **Top badge row** — verdict badge (color + label from
  `_verdict_meta`), severity badge (`sev N/10`), confidence badge
  (`high conf`), context badge (`context: yes` / `context: no`,
  from `_render_context_badge`), optional `CLOSED` red badge.
- **Title** — `r.title` (= `pr_title`).
- **Summary** — `r.summary`.
- **Top bug panel** — `_render_top_bug(r.bugs)`. Picks the most
  severe bug (`_pick_top_bug` via `{critical: 0, high: 1, medium: 2, low: 3}`),
  renders its `issue`, `impact`, and `suggestion` code snippet (if any).
  `_extract_code_snippet(suggestion)` parses the first fenced block.
- **Footer row** — `repo#PR · bugs: N · tok: I↓ / O↑ · cost: $X.XXX`
  on the left; `View on GitHub →` link on the right.

### Plain-text fallback (`_build_text`)

Bullet-style ASCII version of the same content. Used by clients that
don't render HTML or for SMS-style notifications. Includes the same
counters (runs, reviews, closed, bugs, cost, errors) and a
condensed per-PR block. The renderer is preserved verbatim from v1;
data shape changed but layout is intentionally legacy-stable.

---

## Color palette (must stay in sync across all 3 surfaces)

Hex codes used in the email AND mirrored in `dashboard/lib/design.ts`:

| Token | Hex | Where |
|---|---|---|
| bg | `#fafaf9` | page background |
| card | `#ffffff` | card background |
| border | `#e7e5e4` | card borders |
| text | `#1c1917` | primary text |
| muted | `#57534e` | secondary text |
| accent | `#4338ca` | links |
| severity critical (≥9) | `#dc2626` | red |
| severity serious (7-8) | `#ea580c` | orange |
| severity moderate (4-6) | `#ca8a04` | amber |
| severity clean (1-3) | `#16a34a` | green |
| verdict approve | `#16a34a` | green |
| verdict request_changes | `#dc2626` | red |
| verdict comment | `#2563eb` | blue |

If you change a color in `send_digest.py`, change it in
`dashboard/lib/design.ts` too. The dashboard's `severityColor` and
`verdictBadge` helpers MUST match the email's bucketing logic.

---

## Fonts

```python
FONT_MONO  = "'JetBrains Mono', 'SF Mono', 'Menlo', 'Consolas', monospace"
FONT_SERIF = "'Instrument Serif', 'Cormorant Garamond', Georgia, 'Iowan Old Style', 'Charter', serif"
FONT_SANS  = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
```

Webfonts (Instrument Serif, JetBrains Mono) are loaded via a Google
Fonts `<link>` in the email head. Most clients (Gmail web, Apple
Mail) honor it. Outlook strips external stylesheets — the fallback
stack handles that.

---

## When you change the format

Checklist:

1. Update `format_review_comment` and/or `_render_pr_card` together
   (they must remain visually consistent because the dashboard and
   email show the same data).
2. Update the matching dashboard component
   (`dashboard/components/pr-detail.tsx`,
   `dashboard/components/reviews-table.tsx`).
3. If you add a new bug field, update:
   - `agent/prompt.md` § "Output format" schema description.
   - The `review_pr_with_claude` user-message schema block.
   - `_build_reviewer_user_msg` in `review_graph.py` (same schema).
   - The dashboard's `Bug` type in `dashboard/lib/types.ts`.
4. Test with one real PR before merging — visual regressions in the
   markdown renderer are hard to unit-test and very obvious in
   production.
