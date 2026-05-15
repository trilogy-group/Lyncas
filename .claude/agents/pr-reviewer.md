# Agent: PR Reviewer (`reviewer` node)

The first JSON-producing node in `agent/review_graph.py`. Implemented as
`_make_reviewer_node(pr, system_prompt)`. Sits between the
`repo_context` node and the `critic` node in the graph defined by
`_build_graph(pr)`.

## Role as currently implemented

Read a unified diff plus a repo fingerprint plus (optionally) a
diff-specific context note, and produce a JSON review object covering:

- `summary` — 1–2 sentences on what the PR does and overall quality
- `verdict` — `approve` / `request_changes` / `comment`
- `confidence` — `high` / `medium` / `low`
- `severity_score` — 1–10 integer (the gate the auto-close logic reads)
- `bugs[]` — list of `{file, line_hint, severity, issue, impact,
  suggestion, reference}`
- `concerns[]` — same shape, but for non-bug issues (style, naming,
  testing gaps)
- `questions[]` — plain strings
- `praise[]` — plain strings

The system prompt is loaded from `agent/prompt.md` via
`_load_review_system_prompt()`. The reviewer node is **byte-identical**
to the pre-Phase-6 single-pass call (`review_pr_with_claude` in
`pr_reviewer.py`) on its user message — that's deliberate so any
iteration on `prompt.md` flows into the graph unchanged.

## Prompt strategy

Three layered context blocks in the user message, in this order:

1. **`REPOSITORY CONTEXT:`** — the full fingerprint from
   `repo_fingerprints.fingerprint`. Tells the reviewer what stack,
   conventions, and out-of-scope changes apply. May be absent.
2. **`DIFF-SPECIFIC REPO CONTEXT (from repo-context agent):`** — the
   4–8 bullet points the Phase-8 `repo_context` node distilled from
   the fingerprint + this specific diff. Focuses attention on the
   subsystem the diff touches. May be absent (graceful degradation).
3. **`PR DIFF:`** — PR metadata (title, body, author, base ref, changed
   files, additions/deletions) plus the unified diff fenced as
   ```diff. Diff is truncated at `MAX_DIFF_CHARS = 60_000` upstream.

Then a hardcoded JSON schema block reminding Claude of the required
output shape. The schema is duplicated in `agent/prompt.md` § "Output
format" — they must stay in sync.

Token budget: `_REVIEW_MAX_TOKENS = 2000`. Matches the pre-graph cap so
the unchanged prompt sees the same headroom.

## What makes a good vs bad review

The seven hard rules in `agent/prompt.md` are the contract. The
reviewer is a **good** review when:

- Bugs cite `file` paths that actually appear in the diff (rule 1: no
  invented code).
- Bugs that depend on context outside the diff land in `questions`,
  not `bugs` (rule 2: distinguish visible from missing context).
- Severities are calibrated per rule 3 — `critical` is reserved for
  security / data-loss / production-down; `high` is "will likely
  break in production"; padding everything as critical/high makes
  the review useless.
- `confidence` drops to `medium` AT BEST when the diff doesn't show
  the full file or test suite and the bug depends on that context
  (rule 4 — non-optional).
- `severity_score` 9+ is reserved for **the PR's existence being a
  problem** (hardcoded secrets, deleting critical functionality, spam,
  malicious code) — not just "a serious bug exists" (rule 5). This
  rule is what protects the three-gate auto-close from severity
  inflation.
- Empty `bugs`/`concerns` arrays are valid (rule 6 — no padding).
- Linter-level formatting issues aren't flagged (rule 7 — no
  bikeshedding).

A **bad** review either fabricates code that isn't in the diff,
claims `high` confidence on a bug that depends on unseen code,
or inflates `severity_score` past 8 for a non-existential issue.
All three are explicit anti-patterns in `prompt.md`.

## Output handling

`_call_claude_json(...)` calls `_strip_outer_fence(...)` then
`json.loads(...)`. JSON parse failure raises `ValueError("reviewer_node
returned invalid JSON: ...")` and the graph propagates the failure;
`pr_reviewer.main()` catches per-PR exceptions and moves on.

The fence-stripper deliberately removes ONLY the outermost ` ``` `
because the schema explicitly invites Claude to embed fenced code
blocks inside `suggestion` strings — a naive `split("```")` would
chop the response at the first inner fence.

## Field invariants relied on downstream

- `verdict` is one of three exact strings — checked by Supabase
  CHECK constraint on `reviews.verdict`.
- `confidence` is one of three exact strings — Supabase CHECK.
- `severity_score` is an integer 1–10 — Supabase CHECK.
- `bugs` is a list of dicts (never null) — `_merge_bug_lists`,
  `_render_bug_section`, and the digest's `_pick_top_bug` all
  iterate it.
- `_input_tokens` / `_output_tokens` are populated by the call helper
  and required by `compute_cost_usd` for the rendered cost line.

The reviewer is the only node whose output gets shown alongside the
critic and arbiter in the dashboard's "Agent deliberation" section
on `/pr/[id]`. Its framing of a bug wins over the critic's framing in
`_merge_bug_lists` — earlier lists win on dedupe collision so the
reviewer's vocabulary stays in the comment.
