# Agent: Repo Context (`repo_context` node)

First node in `agent/review_graph.py`. Implemented as
`_make_repo_context_node(pr)`. Added in Phase 8; sits at the entry
point of `_build_graph(pr)` and feeds the reviewer + critic + arbiter
nodes a focused context note.

## Role as currently implemented

Read the repo's fingerprint (the general per-repo summary stored in
`repo_fingerprints.fingerprint`) plus a heavily-truncated copy of the
diff, and produce a short focused note that says **which slice of the
repo's conventions actually applies to THIS specific diff**.

## What it extracts

The system prompt (`_REPO_CONTEXT_SYSTEM_PROMPT`) instructs Claude to
return 4–8 plain-text bullet points. Each bullet covers exactly one of:

- Which directory / subsystem this diff touches and what it does
  within the repo (e.g. "this diff modifies `agent/review_graph.py`,
  which is the LangGraph orchestrator").
- Which conventions from the fingerprint apply to the touched files
  (naming, test layout, error handling patterns).
- Which kinds of bugs are worth extra attention here given what this
  subsystem does (e.g. "auth code — check for missing authz", "DB
  layer — check transaction boundaries").
- What is OUT of scope for this repo, if relevant to the diff.

The prompt also instructs Claude to return a single sentinel line
`(no repo-specific context applies)` when the fingerprint is missing
or the diff is too small / unrelated. The node treats that sentinel
as `None` so the reviewer doesn't get a noisy empty bullet list.

This is **plain text**, not JSON. The `_call_claude_text(...)` helper
exists specifically because a stray bullet character would otherwise
fail JSON parsing.

## Why it exists (vs just feeding the fingerprint directly)

The fingerprint is a *general* description of the entire repo — purpose,
stack, all top-level directories, all conventions. For a specific
diff, only a slice is relevant. Pre-Phase-8, the reviewer was told to
do that filtering inline as part of its review work, and it diluted
the reviewer's bug-spotting attention.

The repo-context agent does the filtering once and hands the reviewer
a short, focused note. The reviewer still gets the full fingerprint
too — both blocks are present in the reviewer's user message — but the
focused note is the load-bearing signal.

## Input handling

User message built by `_build_repo_context_user_msg(...)`:

- Fingerprint block (or `"(no repo fingerprint available)"`).
- PR title, base branch, files-changed count.
- Unified diff truncated at `_REPO_CONTEXT_DIFF_CHARS = 8_000`. The
  full 60K-char diff would defeat the "summarize" purpose and inflate
  input tokens unnecessarily.

Token budget: `_REPO_CONTEXT_MAX_TOKENS = 600`. Much smaller than the
reviewer/critic/arbiter caps because the output is a bullet list,
not a JSON review.

## Graceful-degradation contract

Same as Phase 2's fingerprint contract: any failure leaves
`state["diff_specific_context"] = None` and the reviewer runs as if
this node didn't exist. The reviewer's user message builder
(`_build_reviewer_user_msg`) handles `None` by simply omitting the
`DIFF-SPECIFIC REPO CONTEXT:` block — the reviewer still sees the
full fingerprint.

Specific fall-throughs:

1. `state["repo_fingerprint"] is None` (Phase 2 cache miss or clone
   failure) → log `"skipped (no repo fingerprint available)"`, return
   `diff_specific_context = None`. No Claude call.
2. `_call_claude_text(...)` raises (Anthropic 5xx, network) → log the
   exception, return `None`.
3. Claude returns the `"(no repo-specific context applies)"`
   sentinel → store `None` rather than the literal string.
4. Claude returns useful text → strip and store. Print
   `produced N-line context note` for log readability.

In every branch, `total_input_tokens` and `total_output_tokens` on
the state are incremented (even if a call failed and the helper
already accumulated tokens before raising).

## What it does NOT do

- Does NOT review the diff. The reviewer node is the next hop.
- Does NOT flag bugs. The system prompt explicitly forbids this.
- Does NOT touch Supabase. It only reads the fingerprint that
  `pr_reviewer.get_or_refresh_fingerprint()` already loaded into
  `ReviewState`.
- Does NOT regenerate the fingerprint. Cache refresh is the
  `pr_reviewer.py` orchestrator's job, not a graph node's job.

## Field surfaced downstream

`state["diff_specific_context"]: str | None` — read by
`_build_reviewer_user_msg`, `_build_critic_user_msg`, and
`_build_arbiter_user_msg`. None of the three propagate the field
through to `run_review_graph`'s return dict; the diff-specific
context is intentionally an internal-to-the-graph hint. Persisting
it on `reviews` is a v3 dashboard task (would surface on
`/pr/[id]`) and explicitly out of Phase 8 scope.
