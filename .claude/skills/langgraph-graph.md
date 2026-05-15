# Skill: LangGraph graph reference

Reference for `agent/review_graph.py` — the multi-node Claude
orchestration that produces every PR review. Entry point is
`run_review_graph(pr, diff, repo_fingerprint=None)`; everything below
is the internals.

## `ReviewState: TypedDict`

The graph's shared state. Every node receives the full state on input
and returns a partial dict of fields it wants to merge in. Defined
exactly as IMPROVEMENTS_V2 Phase 6 specifies — do not simplify;
downstream tooling and the `/pr/[id]` dashboard panel rely on this
vocabulary verbatim.

```python
class ReviewState(TypedDict):
    # --- Input (set by run_review_graph before invoke) ---
    repo: str
    pr_number: int
    pr_url: str
    diff: str                              # truncated at MAX_DIFF_CHARS = 60_000
    repo_fingerprint: str | None           # loaded by pr_reviewer.py from Supabase

    # --- Phase 8 — populated by repo_context node ---
    diff_specific_context: str | None      # 4-8 bullet points, or None
    prompt_tuner_suggestions: list | None  # always None during graph run (out-of-band)

    # --- Node outputs (the JSON dicts each Claude call returns) ---
    reviewer_output: dict | None
    critic_output:   dict | None
    arbiter_output:  dict | None

    # --- Final (set by _final_node) ---
    final_verdict:  str | None
    final_severity: int | None
    final_bugs:     list | None
    final_summary:  str | None
    escalated:      bool

    # --- Meta (token accumulators, incremented by every node) ---
    total_input_tokens:  int
    total_output_tokens: int
```

**Do not add fields without:**

1. Bumping the migration that persists graph outputs to `reviews`
   (currently 005).
2. Updating `run_review_graph`'s return dict shape.
3. Updating `upsert_review` in `pr_reviewer.py` to plumb the new
   field through.

PR metadata (title, body, author, base ref) is deliberately NOT on
the state. Node factories close over the `pr` dict instead. That
keeps the state strictly to spec.

## Node signatures

Every node is built by a factory that closes over `pr` (and the
shared system prompt when applicable). Each node returns a partial
dict — LangGraph merges it into the state.

| Builder | Returns dict with | Token cap |
|---|---|---|
| `_make_repo_context_node(pr)` | `diff_specific_context, total_input_tokens, total_output_tokens` | `_REPO_CONTEXT_MAX_TOKENS = 600` |
| `_make_reviewer_node(pr, system_prompt)` | `reviewer_output, total_input_tokens, total_output_tokens` | `_REVIEW_MAX_TOKENS = 2000` |
| `_make_critic_node(pr, base_system_prompt)` | `critic_output, total_input_tokens, total_output_tokens` | `_CRITIC_MAX_TOKENS = 2000` |
| `_make_arbiter_node(pr, base_system_prompt)` | `arbiter_output, total_input_tokens, total_output_tokens` | `_ARBITER_MAX_TOKENS = 2000` |
| `_final_node` (plain function, no factory) | `final_verdict, final_severity, final_bugs, final_summary, escalated` | n/a (no Claude call) |

The critic and arbiter system prompts are
`_CRITIC_FRAMING + base_system_prompt` and
`_ARBITER_FRAMING + base_system_prompt` respectively. They share the
reviewer's rubric and JSON schema; only the framing prepends.

The repo-context node has its own self-contained system prompt
(`_REPO_CONTEXT_SYSTEM_PROMPT`) because it produces plain-text
bullets, not JSON.

## Routing logic

Defined in `_route_after_critic(state) -> str`. Only used as the
predicate for the conditional edge out of `critic`:

```python
verdict_differs  = reviewer.verdict != critic.verdict
severity_differs = abs(reviewer.severity_score - critic.severity_score) >= ESCALATION_SEVERITY_DELTA
return "arbiter" if (verdict_differs or severity_differs) else "final"
```

`ESCALATION_SEVERITY_DELTA = 2`. A 1-point severity nudge stays on
the cheap path (no arbiter). A 2+ point delta or any verdict
disagreement escalates.

Wired with:

```python
graph.add_conditional_edges(
    "critic",
    _route_after_critic,
    {"arbiter": "arbiter", "final": "final"},
)
```

## Graph composition

`_build_graph(pr)` builds and compiles the StateGraph:

```python
graph = StateGraph(ReviewState)
graph.add_node("repo_context", _make_repo_context_node(pr))
graph.add_node("reviewer",     _make_reviewer_node(pr, review_system_prompt))
graph.add_node("critic",       _make_critic_node(pr, review_system_prompt))
graph.add_node("arbiter",      _make_arbiter_node(pr, review_system_prompt))
graph.add_node("final",        _final_node)

graph.set_entry_point("repo_context")
graph.add_edge("repo_context", "reviewer")
graph.add_edge("reviewer",     "critic")
graph.add_conditional_edges(
    "critic",
    _route_after_critic,
    {"arbiter": "arbiter", "final": "final"},
)
graph.add_edge("arbiter", "final")
graph.add_edge("final",   END)
return graph.compile()
```

Execution path is deterministic except for the critic→{arbiter,final}
edge.

## Bug merge in `_final_node`

`_merge_bug_lists(reviewer_bugs, critic_bugs, arbiter_bugs_or_empty)`
returns the union deduplicated by:

1. **Exact `(file, line_hint)` match** (when both are non-empty) → dup.
2. **Same file + Jaccard ≥ `_BUG_DEDUP_JACCARD = 0.6`** on issue tokens → dup.

Earlier lists win on collision so the reviewer's framing of a bug
stays in the comment (the reviewer's bug vocabulary is what the
single-pass world produced; the graph preserves it).

`_jaccard` is intersection / union of word-tokenized issue text.
Empty-vs-non-empty pairs return 0.0 to avoid false-positive merges.

## Public entry point

`run_review_graph(pr, diff, repo_fingerprint=None)`:

1. Reads `repo` from `pr["base"]["repo"]["full_name"]` (best-effort).
2. Truncates `diff` to `MAX_DIFF_CHARS = 60_000` if needed, sets the
   `_truncated` flag for the return dict.
3. Builds `initial_state` with all 17 ReviewState fields populated
   (None / 0 / False for everything the graph fills in).
4. `compiled = _build_graph(pr); final_state = compiled.invoke(initial_state)`.
5. Picks `winner = arbiter_output if not None else reviewer_output`.
6. Returns a dict shaped for backward compatibility with
   `review_pr_with_claude(...)`:
   - `summary`, `verdict`, `confidence`, `severity_score` — from the
     winner (with `final_*` overrides).
   - `bugs` — the merged union.
   - `concerns`, `questions`, `praise` — from the winner.
   - `_input_tokens`, `_output_tokens` — graph-wide sums.
   - `_truncated` — diff truncation flag.
   - `_critic_output` — full critic JSON (or None).
   - `_arbiter_output` — full arbiter JSON (or None).
   - `_escalated` — bool.

The `_*` prefixed keys are picked up by `upsert_review` in
`pr_reviewer.py` and persisted to `reviews.critic_output`,
`reviews.arbiter_output`, `reviews.escalated`.

## How to add a new node without breaking existing ones

1. **Decide where it fits in the topology.** Most candidates slot
   either:
   - Before `reviewer` (more context for the reviewer to use, like
     `repo_context` does), or
   - After `final` (post-processing, e.g. a future "explainer" node
     that produces human-readable rationale).
2. **Pick a name** that's lowercase, underscore-free if possible
   (matches existing `repo_context`, `reviewer`, `critic`, `arbiter`,
   `final`).
3. **Define a factory** `_make_<name>_node(pr, ...)` that returns the
   actual node function. The factory closes over PR metadata so the
   `ReviewState` schema stays minimal.
4. **Pick a token budget constant** (`_<NAME>_MAX_TOKENS`) at the top
   of the file. Be conservative — node cost compounds since every
   review pays for every node that runs.
5. **Use the right Claude helper:**
   - JSON output → `_call_claude_json(system=..., user=..., max_tokens=..., tag="<name>_node")`.
     Raises `ValueError("<tag> returned invalid JSON: ...")` on parse
     failure; let it propagate.
   - Plain text → `_call_claude_text(system=..., user=..., max_tokens=...)`.
     No JSON parsing.
6. **Return a partial dict** that includes
   `total_input_tokens` / `total_output_tokens` updates so the meta
   counters stay accurate across the whole graph.
7. **Handle failures non-fatally** unless you genuinely need to abort
   the review. `repo_context` is the model: catch, log to stderr,
   return `None` for its output field and unchanged token counters.
8. **Add a field to `ReviewState`** if the node's output needs to
   reach a downstream node. Pure side-effect nodes (like a future
   "Slack notifier") don't need state fields.
9. **Wire it in `_build_graph(pr)`** with `add_node` + the right
   `add_edge` / `add_conditional_edges` calls. Test the path with a
   manual run.
10. **If the node's output should be persisted**, add a column to
    `reviews` in a new migration (next is 009), surface it in
    `run_review_graph`'s return dict with a `_<name>_output` key,
    and add it to `upsert_review`'s payload in `pr_reviewer.py`.
11. **Don't add the field to the `ReviewState` schema for spec
    compliance** unless it actually needs to be on state. Phase 6
    spec defines the canonical shape; new fields are fine but
    document them.

## Things to NOT do

- **Do not change the routing predicate without thought.** Lowering
  `ESCALATION_SEVERITY_DELTA` to 1 makes every review pay for an
  arbiter call. Raising it past 2 lets material disagreements pass.
- **Do not import from `pr_reviewer.py`.** The file deliberately
  duplicates a couple of constants (`MODEL`, `MAX_DIFF_CHARS`,
  `_strip_outer_fence`) to avoid a circular import. `pr_reviewer.py`
  imports `run_review_graph` from here.
- **Do not let a node leak the Anthropic PAT into stderr.**
  `_call_claude_*` helpers don't print the system prompt by default;
  preserve that.
- **Do not run the graph from `benchmark.py`.** The bench compares
  Sonnet (verbatim from `reviews`) against Opus via
  `review_pr_with_claude`. See `CLAUDE.md` § "Critical constraints".
- **Do not assume `winner.confidence` is always present.** The graph
  has fallback chains in `run_review_graph` precisely because the
  arbiter or critic might return a JSON missing `confidence` — fall
  back to `reviewer.confidence` then to the string `"medium"`.
