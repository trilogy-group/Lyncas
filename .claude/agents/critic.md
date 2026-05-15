# Agent: Critic (`critic` node)

Second JSON-producing node in `agent/review_graph.py`. Implemented as
`_make_critic_node(pr, base_system_prompt)`. Runs immediately after the
`reviewer` node, immediately before `_route_after_critic` decides
whether to escalate.

## Role as currently implemented

Adversarial second pass on a PR review. The critic receives the SAME
diff, fingerprint, and diff-specific context as the reviewer, PLUS the
reviewer's full JSON output, and must produce its OWN independent
review in the same JSON schema.

System prompt = `_CRITIC_FRAMING + base_system_prompt`. The critic
inherits the reviewer's rubric (severity calibration, confidence
rules, output schema) verbatim — the framing block prepends only the
"challenge this" framing on top. Token budget: `_CRITIC_MAX_TOKENS = 2000`.

The user message is built by `_build_critic_user_msg(...)` which
wraps the reviewer's JSON in:

```
FIRST REVIEWER'S OUTPUT (challenge this — agree or disagree honestly):
```json
{ ...reviewer JSON... }
```

---

<then the standard reviewer user message follows>
```

## What the critic SHOULD challenge

Three things, in order of importance:

1. **Bugs the reviewer missed.** Re-read the diff with the question
   "what real bug is in here that the first reviewer didn't flag?".
   Look for broken logic, security gaps, error-handling holes, race
   conditions, missing tests for new behavior.
2. **Bugs the reviewer over-flagged.** Are any of the reviewer's
   `bugs` actually fine? Or are they real issues mis-severitied
   (low marked high, etc.)?
3. **Severity calibration.** Is `severity_score` per the rubric in
   `prompt.md` § 5, or inflated/deflated?

The critic's `bugs[]` is its OWN list — overlap with the reviewer's
list is fine, total disagreement is fine, full agreement is fine.

## What the critic should NOT over-flag

The critic's job is to **be honest**, not to differ for the sake of
seeming useful. The framing block says this explicitly:

> If you genuinely agree with the first reviewer, return the same
> verdict and severity_score — do not artificially differ to seem
> useful. If you disagree, return your honest second opinion.

The router (`_route_after_critic`) reads `critic_output.verdict` and
`critic_output.severity_score` literally. If the critic invents
disagreement, it triggers a pointless arbiter call (~$0.20–$0.50 of
Opus tokens) for nothing.

Specifically, the critic should NOT:

- Pile on additional low-severity nitpicks just to have a longer
  bug list. The reviewer's rule 7 (no bikeshedding) applies equally.
- Bump severity by one notch to look more rigorous. The router
  triggers on `|Δseverity| ≥ 2 = ESCALATION_SEVERITY_DELTA`, but
  any inflation degrades the calibration the arbiter then has to
  un-do.
- Flip `verdict` from `approve` to `comment` to look less
  rubber-stampy. `verdict_differs` is a hard escalation trigger,
  so a vibes-based flip is expensive.

If the critic is wrong about a bug the reviewer flagged, just leave
it off the critic's list — `_merge_bug_lists` is union-based, so the
reviewer's bug survives anyway.

## Routing impact

The critic's output drives exactly one decision in
`_route_after_critic`:

```python
verdict_differs  = reviewer.verdict != critic.verdict
severity_differs = abs(reviewer.severity_score - critic.severity_score) >= 2
if verdict_differs or severity_differs:
    return "arbiter"
return "final"
```

`ESCALATION_SEVERITY_DELTA = 2` was chosen so a 1-point severity
nudge (which is within normal calibration noise) doesn't escalate,
but a 2-point swing (e.g. reviewer 6, critic 8 — that's a real
disagreement about whether the PR needs serious rework) does.

## Output handling

Same as the reviewer: `_call_claude_json(...)` → `json.loads(...)`.
JSON parse failure raises `ValueError("critic_node returned invalid
JSON: ...")` — the graph propagates it as a per-PR exception and
`pr_reviewer.main()` moves on. The review row never gets persisted
in that case, so the PR is re-tried on the next cron tick (no
marker was posted).

`critic_output` lands on `state["critic_output"]`, gets persisted to
`reviews.critic_output jsonb` by `upsert_review`, and surfaces on
`/pr/[id]` in the "Agent deliberation" panel.
