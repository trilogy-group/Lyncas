"""
review_graph.py — LangGraph orchestration for PR review.

Phase 6 introduced the structured graph. Phase 8 extends it with a
Repo Context Agent in front of the reviewer:

    diff + fingerprint
      → [Repo Context Node]      (extracts diff-specific repo context)
      → [Reviewer Node]          (standard review pass, sees the context)
      → [Critic  Node]           (adversarial: what did the reviewer miss / over-flag?)
      → router
            ↘ (if verdict differs OR |Δseverity| ≥ 2)
               → [Arbiter Node]  (independent third pass, sees both prior outputs)
      → [Final Node]             (merges outputs, builds comment payload)

Why three passes (Phase 6):
  Single-pass review has predictable blind spots — confirmation bias on the
  first pattern Claude latches onto, missed subtle bugs in long diffs,
  occasional severity inflation. The critic adds an explicit adversarial
  step. The arbiter only runs when the first two disagree meaningfully, so
  we pay for it on the cases that matter and skip it on clean PRs.

Why a Repo Context Agent (Phase 8):
  The repo fingerprint is a *general* description of the repo. For a
  specific diff, only a slice of that fingerprint is relevant — the
  directories the diff actually touches, the conventions that govern those
  files, and the kinds of bugs that matter for that subsystem. Forcing the
  reviewer to do this filtering inline diluted its bug-spotting attention.
  The Repo Context Agent does the filtering once and hands the reviewer a
  short, focused note. The Phase 2 graceful-degradation contract still
  applies: with no fingerprint (or a Claude failure here), we fall through
  to the same prompt the reviewer used pre-Phase-8.

The reviewer's prompt is unchanged from Phase 3 (agent/prompt.md) so any
prompt iteration there flows into the graph automatically. The Phase 8
diff-specific context is layered on top as additional context, not a
replacement for the rubric.

Returns a dict shaped like `review_pr_with_claude(...)`'s return so the
existing `format_review_comment`, `should_auto_close`, and `upsert_review`
in pr_reviewer.py continue to work without churn. The new fields the graph
contributes — _critic_output, _arbiter_output, _escalated — are picked up
by upsert_review's payload (see migration 005).
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import TypedDict

from anthropic import Anthropic
from langgraph.graph import END, StateGraph

# --- Config & shared client ----------------------------------------------
# We deliberately re-construct the Anthropic client + reload constants here
# instead of importing from pr_reviewer to avoid a circular import (the main
# script imports run_review_graph from this module).

MODEL = "claude-opus-4-5"
MAX_DIFF_CHARS = 60_000
PROMPT_PATH = Path(__file__).parent / "prompt.md"

# Per-node token ceilings. Reviewer matches the pre-Phase-6 cap (2000) so
# the unchanged prompt sees the same budget. Critic and arbiter get the
# same headroom since they produce the same schema. Repo context is a
# short bullet list, not JSON, so it gets a much smaller cap.
_REVIEW_MAX_TOKENS = 2000
_CRITIC_MAX_TOKENS = 2000
_ARBITER_MAX_TOKENS = 2000
_REPO_CONTEXT_MAX_TOKENS = 600

# Hard cap on the repo-context node's diff payload. The whole point of
# this node is to *summarize* — feeding it the full 60K-char diff defeats
# the purpose and inflates input tokens. We keep just enough of the diff
# to identify which files / dirs are touched.
_REPO_CONTEXT_DIFF_CHARS = 8_000

# Router threshold: |reviewer.severity - critic.severity| >= 2 escalates.
ESCALATION_SEVERITY_DELTA = 2

# Bug-merge thresholds. Two bugs with the same (file, line_hint) collapse
# unconditionally; same-file pairs collapse if the issue-token Jaccard
# clears _BUG_DEDUP_JACCARD. Tuned conservatively — we'd rather keep a
# borderline-duplicate bug than silently drop a real one.
_BUG_DEDUP_JACCARD = 0.6

_client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])


def _load_review_system_prompt() -> str:
    return PROMPT_PATH.read_text(encoding="utf-8")


# --- Repo Context, Critic & Arbiter system prompts -----------------------
# The critic and arbiter framings are intentionally short framings
# *prepended* to the reviewer's prompt, so all three review nodes share
# the exact same severity rubric and JSON schema. The critic and arbiter
# then layer their own behavior on top. Keeping the rubric central avoids
# drift between the three nodes.
#
# The Repo Context Agent (Phase 8) is structurally different: it does NOT
# produce a JSON review, it produces a short plain-text bullet list that
# becomes additional context for the reviewer. It therefore has its own
# self-contained system prompt and does not inherit the reviewer rubric.

_REPO_CONTEXT_SYSTEM_PROMPT = """You are a senior code reviewer's research assistant. Your one job is to
read a repository fingerprint and a unified PR diff, and produce a short
focused note of the repo context that is most relevant to reviewing THIS
specific diff.

Output requirements:
1. Return 4-8 plain-text bullet points. No preamble, no closing remarks.
2. Each bullet covers ONE of:
   - Which directory / subsystem this diff touches and what it does
     within the repo
   - Which conventions from the fingerprint apply to the touched files
     (naming, test layout, error handling, etc.)
   - Which kinds of bugs are worth extra attention here given what this
     subsystem does (e.g. "auth code — check for missing authz" /
     "DB layer — check transaction boundaries")
   - What is OUT of scope for this repo, if relevant to the diff
3. Be specific and factual. Cite the fingerprint or the diff. Do NOT
   invent conventions or directories that are not stated.
4. If the fingerprint is missing or the diff is too small / unrelated to
   give meaningful repo-specific context, return the single line:
   "(no repo-specific context applies)"

Do not review the diff. Do not flag bugs. Do not produce JSON. Your
output is consumed verbatim by the reviewer node as additional context."""

_CRITIC_FRAMING = """You are a second-pass adversarial reviewer on a GitHub PR. A first reviewer
has already produced a JSON analysis. Your job is to *challenge* it.

Specifically:
1. What did the first reviewer MISS? Look for real bugs in the diff that
   they did not flag — broken logic, security issues, error-handling gaps,
   race conditions, missing tests for new behavior.
2. What did the first reviewer OVER-FLAG? Are any of their "bugs" actually
   fine, or low-severity issues being mislabeled high/critical?
3. Is their severity_score calibrated per the rubric below, or inflated /
   deflated?

You receive the diff, optional repo context, and the first reviewer's full
JSON. Return your OWN independent JSON in the exact same schema. List the
bugs YOU believe are real (your list may overlap with, differ from, or
fully agree with the first reviewer's). The same severity / confidence /
severity_score rules apply to you.

If you genuinely agree with the first reviewer, return the same verdict
and severity_score — do not artificially differ to seem useful. If you
disagree, return your honest second opinion.

The rest of this system prompt is the shared reviewer rubric — follow it
exactly when producing your output.

----- shared reviewer rubric below -----

"""

_ARBITER_FRAMING = """You are an arbiter making the FINAL call on a GitHub PR review. Two prior
reviewers disagreed — by verdict, by severity_score (delta >= 2), or both.
You receive the diff, optional repo context, and both prior JSON outputs.

Your job is the tie-breaker:
1. Read the diff yourself. Do not rubber-stamp either prior reviewer.
2. Evaluate which reviewer's specific bug claims are supported by the
   diff and which are not.
3. Make an independent verdict, confidence, and severity_score per the
   rubric below.
4. Your `bugs` list should be the bugs YOU stand behind — drawing from
   both prior lists or adding ones neither caught.

This is the binding final judgment for downstream automation (auto-close,
comment). Score conservatively per the rubric.

The rest of this system prompt is the shared reviewer rubric — follow it
exactly when producing your output.

----- shared reviewer rubric below -----

"""


# --- State schema --------------------------------------------------------
# Defined exactly as IMPROVEMENTS_v2.md Phase 6 specifies. Do not simplify;
# downstream tooling (and the Phase 6 dashboard surface) expects this
# vocabulary verbatim. The PR metadata that the reviewer node needs (title,
# body, author, base ref) is closed over by node factories rather than
# stuffed into the state — that keeps the state strictly to the spec while
# still giving the model the full context.

class ReviewState(TypedDict):
    # Input
    repo: str
    pr_number: int
    pr_url: str
    diff: str
    repo_fingerprint: str | None

    # Phase 8 — populated by the Repo Context Agent before the reviewer
    # runs. The reviewer node reads this and includes it in its user
    # message. None when fingerprint is unavailable or the context node
    # itself failed (graceful degradation: reviewer still runs).
    diff_specific_context: str | None

    # Phase 8 — placeholder for prompt-tuner output. The Prompt Tuner
    # Agent runs *out of band* (separate scheduled script, not a graph
    # node), so this field is currently always None when the graph
    # executes. We keep it on the state for spec-compatibility and to
    # leave room for a future "show prompt-tuner suggestions inline in
    # the review comment" feature without another schema migration.
    prompt_tuner_suggestions: list | None

    # Node outputs
    reviewer_output: dict | None
    critic_output: dict | None
    arbiter_output: dict | None

    # Final
    final_verdict: str | None
    final_severity: int | None
    final_bugs: list | None
    final_summary: str | None
    escalated: bool

    # Meta
    total_input_tokens: int
    total_output_tokens: int


# --- Claude call helper --------------------------------------------------

def _strip_outer_fence(text: str) -> str:
    """Drop only the outermost ```...``` fence if Claude wraps its JSON.

    Mirror of the Phase-3 fence-stripping fix in pr_reviewer.py:
    Claude's schema embeds fenced code blocks inside `suggestion` strings,
    so a naive split("```") would chop the response at the first inner
    fence and leave us with an unterminated string. We only strip the
    outermost opener line and the trailing fence."""
    text = text.strip()
    if text.startswith("```"):
        first_nl = text.find("\n")
        text = text[first_nl + 1 :] if first_nl != -1 else text[3:]
        text = text.rstrip()
        if text.endswith("```"):
            text = text[:-3].rstrip()
    return text


def _call_claude_json(
    *,
    system: str,
    user: str,
    max_tokens: int,
    tag: str,
) -> tuple[dict, int, int]:
    """One Claude call → parsed JSON dict + (input_tokens, output_tokens).

    `tag` is used only in error messages so a failure in any node names the
    node responsible. Raises on parse failure — the caller decides whether
    to surface the error or fall through to a sibling node."""
    response = _client.messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    raw = response.content[0].text.strip()
    text = _strip_outer_fence(raw)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(
            f"{tag} returned invalid JSON: {e} — first 200 chars: {text[:200]}"
        ) from e
    return parsed, response.usage.input_tokens, response.usage.output_tokens


# --- User-message templates ----------------------------------------------

def _build_repo_context_user_msg(
    pr: dict, diff: str, repo_fingerprint: str | None
) -> str:
    """User message for the Phase-8 Repo Context Agent. We deliberately
    truncate the diff hard here — the node's job is to summarize *which
    parts* of the repo the diff touches, not to read every hunk. The full
    diff still goes to the reviewer node."""
    fingerprint_block = (
        repo_fingerprint
        if repo_fingerprint
        else "(no repo fingerprint available)"
    )
    diff_for_context = diff
    if len(diff_for_context) > _REPO_CONTEXT_DIFF_CHARS:
        diff_for_context = (
            diff_for_context[:_REPO_CONTEXT_DIFF_CHARS]
            + "\n\n[... diff truncated for context extraction ...]"
        )
    return f"""REPOSITORY FINGERPRINT:
{fingerprint_block}

---

PR METADATA:
title: {pr['title']}
base branch: {pr['base']['ref']}
files changed: {pr.get('changed_files', 'unknown')}

UNIFIED DIFF (truncated for context extraction):
```diff
{diff_for_context}
```

Produce the diff-specific repo context note now, per the system prompt's bullet rules."""


def _build_reviewer_user_msg(
    pr: dict,
    diff: str,
    repo_fingerprint: str | None,
    diff_specific_context: str | None = None,
) -> str:
    """Identical to pr_reviewer.review_pr_with_claude's user message —
    the reviewer node is meant to be byte-identical to the pre-graph call
    so any Phase 3 prompt iteration still applies unchanged.

    Phase 8 layers an optional `diff_specific_context` block produced by
    the Repo Context Agent on top of the base fingerprint. We keep both:
    the fingerprint gives the reviewer the full repo description; the
    diff-specific note focuses attention. When the repo-context node is
    skipped or fails, this falls back to the Phase-3 shape automatically."""
    context_parts: list[str] = []
    if repo_fingerprint:
        context_parts.append(f"REPOSITORY CONTEXT:\n{repo_fingerprint}")
    if diff_specific_context:
        context_parts.append(
            "DIFF-SPECIFIC REPO CONTEXT (from repo-context agent):\n"
            f"{diff_specific_context}"
        )
    context_block = ""
    if context_parts:
        context_block = "\n\n".join(context_parts) + "\n\n---\n\n"

    return f"""{context_block}PR DIFF:
PR title: {pr['title']}
PR description: {pr.get('body') or '(none)'}
Author: {pr['user']['login']}
Base branch: {pr['base']['ref']}
Files changed: {pr.get('changed_files', 'unknown')}
Additions: +{pr.get('additions', '?')} / Deletions: -{pr.get('deletions', '?')}

Unified diff:
```diff
{diff}
```

Respond ONLY with valid JSON matching this schema (no markdown fences, no prose before or after):
{{
  "summary": "1-2 sentence summary of what the PR does AND overall quality",
  "verdict": "approve" | "request_changes" | "comment",
  "confidence": "high" | "medium" | "low",
  "severity_score": 1-10 integer (see prompt rubric — 9+ triggers auto-close, be conservative),
  "bugs": [
    {{
      "file": "exact path from the diff, or \\"multiple files\\"",
      "line_hint": "42" | "42-58" | null,
      "severity": "critical" | "high" | "medium" | "low",
      "issue": "one sentence: what is wrong",
      "impact": "one sentence: what could go wrong if unfixed",
      "suggestion": "concrete fix (prose, or a fenced code snippet of <=10 lines)",
      "reference": "URL to a doc/RFC/CVE/spec if you can cite one accurately, else null"
    }}
  ],
  "concerns": [
    {{
      "file": "path or \\"multiple files\\"",
      "line_hint": "42" | "42-58" | null,
      "severity": "low" | "medium",
      "issue": "non-bug concern: style, naming, testing gap, etc.",
      "impact": "why this concern matters in one sentence",
      "suggestion": "concrete improvement",
      "reference": null
    }}
  ],
  "questions": ["questions you'd ask the author if you were unsure"],
  "praise": ["specific things done well — leave empty if nothing stands out"]
}}

The prompt.md `Output format` section spells out every field's exact content requirements — follow them. If a field doesn't apply (e.g. no good doc to reference), use `null`, not a made-up value."""


def _build_critic_user_msg(
    pr: dict,
    diff: str,
    repo_fingerprint: str | None,
    reviewer_output: dict,
    diff_specific_context: str | None = None,
) -> str:
    """Wraps the reviewer user message with the prior reviewer's full
    JSON, so the critic sees exactly what it is challenging. The Phase-8
    diff-specific context (if any) is carried through to the critic so
    both passes see the same repo context."""
    base = _build_reviewer_user_msg(
        pr, diff, repo_fingerprint, diff_specific_context
    )
    return (
        "FIRST REVIEWER'S OUTPUT (challenge this — agree or disagree honestly):\n"
        "```json\n"
        f"{json.dumps(reviewer_output, indent=2, ensure_ascii=False)}\n"
        "```\n\n"
        "---\n\n"
        f"{base}"
    )


def _build_arbiter_user_msg(
    pr: dict,
    diff: str,
    repo_fingerprint: str | None,
    reviewer_output: dict,
    critic_output: dict,
    diff_specific_context: str | None = None,
) -> str:
    """Wraps the reviewer user message with both prior JSON outputs so
    the arbiter has full deliberation context. The Phase-8 diff-specific
    context (if any) is also threaded through so the arbiter sees the
    same repo context as the prior two passes."""
    base = _build_reviewer_user_msg(
        pr, diff, repo_fingerprint, diff_specific_context
    )
    return (
        "FIRST REVIEWER'S OUTPUT:\n"
        "```json\n"
        f"{json.dumps(reviewer_output, indent=2, ensure_ascii=False)}\n"
        "```\n\n"
        "SECOND-PASS CRITIC'S OUTPUT:\n"
        "```json\n"
        f"{json.dumps(critic_output, indent=2, ensure_ascii=False)}\n"
        "```\n\n"
        "The two outputs disagree on verdict or severity. Make the final call.\n\n"
        "---\n\n"
        f"{base}"
    )


# --- Bug merge -----------------------------------------------------------

_TOKEN_RE = re.compile(r"\w+")


def _tokenize_issue(text: str | None) -> set[str]:
    return set(_TOKEN_RE.findall((text or "").lower()))


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _bug_key(bug: dict) -> tuple[str, str]:
    file = (bug.get("file") or "").lower()
    line = str(bug.get("line_hint") or "")
    return (file, line)


def _merge_bug_lists(*bug_lists: list | None) -> list:
    """Union of bugs across node outputs, deduplicated by (file, line_hint)
    exact match or same-file Jaccard >= _BUG_DEDUP_JACCARD on issue text.

    Earlier lists win on collision so the reviewer's framing of a bug
    takes precedence over the critic's framing of the same bug (the
    reviewer's wording is what the author saw in the rich comment in
    the single-pass world; the graph preserves that vocabulary)."""
    merged: list = []
    for bugs in bug_lists:
        for b in bugs or []:
            if not isinstance(b, dict):
                continue
            key_b = _bug_key(b)
            tokens_b = _tokenize_issue(b.get("issue"))
            is_dup = False
            for existing in merged:
                key_e = _bug_key(existing)
                if key_b == key_e and key_b != ("", ""):
                    is_dup = True
                    break
                if key_b[0] and key_b[0] == key_e[0]:
                    tokens_e = _tokenize_issue(existing.get("issue"))
                    if _jaccard(tokens_b, tokens_e) >= _BUG_DEDUP_JACCARD:
                        is_dup = True
                        break
            if not is_dup:
                merged.append(b)
    return merged


# --- Nodes ---------------------------------------------------------------
# Each node is built as a closure over the PR dict so the strict ReviewState
# schema stays exactly as specified in Phase 6 (no PR metadata fields).

def _call_claude_text(
    *,
    system: str,
    user: str,
    max_tokens: int,
) -> tuple[str, int, int]:
    """One Claude call → plain-text response + (input_tokens, output_tokens).

    Used by the Phase-8 Repo Context Agent, which produces a bullet list
    rather than JSON. Kept separate from `_call_claude_json` so a stray
    bullet character can't fail JSON parsing."""
    response = _client.messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    text = response.content[0].text.strip()
    return text, response.usage.input_tokens, response.usage.output_tokens


def _make_repo_context_node(pr: dict):
    """Phase 8 — the first node in the graph. Reads the repo fingerprint
    from state (loaded by the orchestrator from Supabase repo_fingerprints
    in pr_reviewer.py) and asks Claude to produce a short note focused on
    THIS diff's subsystem and conventions. Writes the note to
    `diff_specific_context`, which the reviewer/critic/arbiter all read.

    Failure is non-fatal — on any error or with no fingerprint, we leave
    diff_specific_context = None and the rest of the graph behaves as in
    Phase 6 (reviewer just sees the raw fingerprint). This is the same
    graceful-degradation contract Phase 2 set for the fingerprint itself."""

    def repo_context_node(state: ReviewState) -> dict:
        tag = f"  [graph:{state['repo']}#{state['pr_number']}] repo context node"
        fingerprint = state.get("repo_fingerprint")
        if not fingerprint:
            print(
                f"{tag}: skipped (no repo fingerprint available — "
                f"diff_specific_context will be None)",
                file=sys.stderr,
            )
            return {
                "diff_specific_context": None,
                "total_input_tokens": state.get("total_input_tokens", 0),
                "total_output_tokens": state.get("total_output_tokens", 0),
            }

        print(f"{tag}: extracting diff-specific context...", file=sys.stderr)
        try:
            user_msg = _build_repo_context_user_msg(
                pr, state["diff"], fingerprint
            )
            text, in_tok, out_tok = _call_claude_text(
                system=_REPO_CONTEXT_SYSTEM_PROMPT,
                user=user_msg,
                max_tokens=_REPO_CONTEXT_MAX_TOKENS,
            )
        except Exception as e:
            print(
                f"{tag}: failed ({e}) — falling through without diff-specific context",
                file=sys.stderr,
            )
            return {
                "diff_specific_context": None,
                "total_input_tokens": state.get("total_input_tokens", 0),
                "total_output_tokens": state.get("total_output_tokens", 0),
            }

        # The system prompt instructs Claude to return a literal sentinel
        # when there's nothing useful to say. Treat that as "no context"
        # so the reviewer doesn't get a noisy empty bullet list.
        cleaned = text.strip()
        if cleaned == "(no repo-specific context applies)":
            cleaned_out: str | None = None
            print(
                f"{tag}: model returned no-context sentinel — diff_specific_context=None",
                file=sys.stderr,
            )
        else:
            cleaned_out = cleaned
            print(
                f"{tag}: produced {len(cleaned.splitlines())}-line context note",
                file=sys.stderr,
            )

        return {
            "diff_specific_context": cleaned_out,
            "total_input_tokens": state.get("total_input_tokens", 0) + in_tok,
            "total_output_tokens": state.get("total_output_tokens", 0) + out_tok,
        }

    return repo_context_node


def _make_reviewer_node(pr: dict, system_prompt: str):
    def reviewer_node(state: ReviewState) -> dict:
        print(f"  [graph:{state['repo']}#{state['pr_number']}] reviewer node...", file=sys.stderr)
        user_msg = _build_reviewer_user_msg(
            pr,
            state["diff"],
            state.get("repo_fingerprint"),
            state.get("diff_specific_context"),
        )
        output, in_tok, out_tok = _call_claude_json(
            system=system_prompt,
            user=user_msg,
            max_tokens=_REVIEW_MAX_TOKENS,
            tag="reviewer_node",
        )
        return {
            "reviewer_output": output,
            "total_input_tokens": state.get("total_input_tokens", 0) + in_tok,
            "total_output_tokens": state.get("total_output_tokens", 0) + out_tok,
        }

    return reviewer_node


def _make_critic_node(pr: dict, base_system_prompt: str):
    system = _CRITIC_FRAMING + base_system_prompt

    def critic_node(state: ReviewState) -> dict:
        print(f"  [graph:{state['repo']}#{state['pr_number']}] critic node...", file=sys.stderr)
        reviewer_output = state.get("reviewer_output") or {}
        user_msg = _build_critic_user_msg(
            pr,
            state["diff"],
            state.get("repo_fingerprint"),
            reviewer_output,
            state.get("diff_specific_context"),
        )
        output, in_tok, out_tok = _call_claude_json(
            system=system,
            user=user_msg,
            max_tokens=_CRITIC_MAX_TOKENS,
            tag="critic_node",
        )
        return {
            "critic_output": output,
            "total_input_tokens": state.get("total_input_tokens", 0) + in_tok,
            "total_output_tokens": state.get("total_output_tokens", 0) + out_tok,
        }

    return critic_node


def _make_arbiter_node(pr: dict, base_system_prompt: str):
    system = _ARBITER_FRAMING + base_system_prompt

    def arbiter_node(state: ReviewState) -> dict:
        print(f"  [graph:{state['repo']}#{state['pr_number']}] arbiter node (escalated)...", file=sys.stderr)
        reviewer_output = state.get("reviewer_output") or {}
        critic_output = state.get("critic_output") or {}
        user_msg = _build_arbiter_user_msg(
            pr,
            state["diff"],
            state.get("repo_fingerprint"),
            reviewer_output,
            critic_output,
            state.get("diff_specific_context"),
        )
        output, in_tok, out_tok = _call_claude_json(
            system=system,
            user=user_msg,
            max_tokens=_ARBITER_MAX_TOKENS,
            tag="arbiter_node",
        )
        return {
            "arbiter_output": output,
            "total_input_tokens": state.get("total_input_tokens", 0) + in_tok,
            "total_output_tokens": state.get("total_output_tokens", 0) + out_tok,
        }

    return arbiter_node


def _route_after_critic(state: ReviewState) -> str:
    """Conditional edge: send to arbiter on meaningful disagreement, else
    short-circuit to the final node. Meaningful = differing verdict OR
    severity score delta >= ESCALATION_SEVERITY_DELTA (per Phase 6 spec)."""
    reviewer = state.get("reviewer_output") or {}
    critic = state.get("critic_output") or {}

    r_verdict = (reviewer.get("verdict") or "").strip()
    c_verdict = (critic.get("verdict") or "").strip()

    r_sev = reviewer.get("severity_score")
    c_sev = critic.get("severity_score")

    verdict_differs = bool(r_verdict and c_verdict and r_verdict != c_verdict)
    severity_differs = (
        isinstance(r_sev, int)
        and isinstance(c_sev, int)
        and abs(r_sev - c_sev) >= ESCALATION_SEVERITY_DELTA
    )

    if verdict_differs or severity_differs:
        print(
            f"  [graph:{state['repo']}#{state['pr_number']}] router: ESCALATE "
            f"(verdicts r={r_verdict!r} c={c_verdict!r}, severity r={r_sev} c={c_sev})",
            file=sys.stderr,
        )
        return "arbiter"
    print(
        f"  [graph:{state['repo']}#{state['pr_number']}] router: agree "
        f"(verdict={r_verdict}, severity r={r_sev} c={c_sev}) — skip arbiter",
        file=sys.stderr,
    )
    return "final"


def _final_node(state: ReviewState) -> dict:
    """Pick the final verdict/severity (arbiter if escalated, reviewer
    otherwise) and merge the bug union across all node outputs."""
    reviewer = state.get("reviewer_output") or {}
    critic = state.get("critic_output") or {}
    arbiter = state.get("arbiter_output")
    escalated = arbiter is not None

    winner = arbiter if escalated else reviewer

    final_bugs = _merge_bug_lists(
        reviewer.get("bugs"),
        critic.get("bugs"),
        (arbiter or {}).get("bugs"),
    )

    print(
        f"  [graph:{state['repo']}#{state['pr_number']}] final node: "
        f"verdict={winner.get('verdict')}, severity={winner.get('severity_score')}, "
        f"bugs(merged)={len(final_bugs)}, escalated={escalated}",
        file=sys.stderr,
    )

    return {
        "final_verdict": winner.get("verdict"),
        "final_severity": winner.get("severity_score"),
        "final_summary": winner.get("summary"),
        "final_bugs": final_bugs,
        "escalated": escalated,
    }


# --- Graph builder & entry point -----------------------------------------

def _build_graph(pr: dict):
    """Builds and compiles the StateGraph for one PR. Node closures bind
    the PR metadata so ReviewState stays exactly as the spec specifies.

    Phase 8 wires the Repo Context Agent in front of the reviewer:
      repo_context → reviewer → critic → router → (arbiter) → final
    The repo-context node is non-fatal: on any failure it returns
    diff_specific_context=None and the rest of the graph runs unchanged."""
    review_system_prompt = _load_review_system_prompt()

    graph = StateGraph(ReviewState)
    graph.add_node("repo_context", _make_repo_context_node(pr))
    graph.add_node("reviewer", _make_reviewer_node(pr, review_system_prompt))
    graph.add_node("critic", _make_critic_node(pr, review_system_prompt))
    graph.add_node("arbiter", _make_arbiter_node(pr, review_system_prompt))
    graph.add_node("final", _final_node)

    graph.set_entry_point("repo_context")
    graph.add_edge("repo_context", "reviewer")
    graph.add_edge("reviewer", "critic")
    graph.add_conditional_edges(
        "critic",
        _route_after_critic,
        {"arbiter": "arbiter", "final": "final"},
    )
    graph.add_edge("arbiter", "final")
    graph.add_edge("final", END)
    return graph.compile()


def run_review_graph(
    pr: dict,
    diff: str,
    repo_fingerprint: str | None = None,
) -> dict:
    """Run the graph for one PR and return a dict compatible with the
    pre-Phase-6 `review_pr_with_claude` return shape.

    Compatibility keys (consumed by format_review_comment / should_auto_close
    / upsert_review in pr_reviewer.py):
      - summary, verdict, confidence, severity_score
      - bugs (the merged union — what gets rendered in the PR comment)
      - concerns, questions, praise (taken from the winner — reviewer or arbiter)
      - _input_tokens, _output_tokens   (sum across all nodes, including
                                         the Phase-8 repo-context node)
      - _truncated                       (True if MAX_DIFF_CHARS was hit)

    Keys introduced in Phase 6 (consumed by upsert_review):
      - _critic_output   (full critic JSON, or None on critic-side failure)
      - _arbiter_output  (full arbiter JSON, or None if arbiter did not fire)
      - _escalated       (True iff arbiter fired)

    Phase 8 does not add new keys to the return dict — the repo-context
    node's output stays internal to the graph (it's just additional
    context for the reviewer). Persisting it is intentionally deferred:
    the dashboard would render it on /pr/[id], and that page is
    explicitly out of Phase 8 scope.
    """
    repo = pr.get("base", {}).get("repo", {}).get("full_name") or "?"
    pr_url = pr.get("html_url") or ""

    truncated = False
    if len(diff) > MAX_DIFF_CHARS:
        diff = diff[:MAX_DIFF_CHARS] + "\n\n[... diff truncated ...]"
        truncated = True

    initial_state: ReviewState = {
        "repo": repo,
        "pr_number": pr["number"],
        "pr_url": pr_url,
        "diff": diff,
        "repo_fingerprint": repo_fingerprint,
        "diff_specific_context": None,
        "prompt_tuner_suggestions": None,
        "reviewer_output": None,
        "critic_output": None,
        "arbiter_output": None,
        "final_verdict": None,
        "final_severity": None,
        "final_bugs": None,
        "final_summary": None,
        "escalated": False,
        "total_input_tokens": 0,
        "total_output_tokens": 0,
    }

    compiled = _build_graph(pr)
    final_state: ReviewState = compiled.invoke(initial_state)  # type: ignore[assignment]

    reviewer = final_state.get("reviewer_output") or {}
    arbiter = final_state.get("arbiter_output")
    winner = arbiter if arbiter is not None else reviewer

    return {
        # --- pre-Phase-6 compatibility shape ---
        "summary": final_state.get("final_summary") or winner.get("summary") or "",
        "verdict": final_state.get("final_verdict") or winner.get("verdict") or "comment",
        "confidence": winner.get("confidence") or reviewer.get("confidence") or "medium",
        "severity_score": (
            final_state.get("final_severity")
            if final_state.get("final_severity") is not None
            else winner.get("severity_score")
        ),
        "bugs": final_state.get("final_bugs") or [],
        "concerns": winner.get("concerns") or reviewer.get("concerns") or [],
        "questions": winner.get("questions") or reviewer.get("questions") or [],
        "praise": winner.get("praise") or reviewer.get("praise") or [],
        "_input_tokens": final_state.get("total_input_tokens", 0),
        "_output_tokens": final_state.get("total_output_tokens", 0),
        "_truncated": truncated,
        # --- Phase 6 additions ---
        "_critic_output": final_state.get("critic_output"),
        "_arbiter_output": final_state.get("arbiter_output"),
        "_escalated": bool(final_state.get("escalated")),
    }
