# PROJECT_PLAN.md — Lyncas

Forward-looking plan for the autonomous PR-review agent. Companion docs:
[ARCHITECTURE.md](ARCHITECTURE.md) (how the system is wired today),
[CLAUDE.md](CLAUDE.md) (rules for AI assistants picking this up next session).

---

## What this project is

Lyncas is an autonomous agent that wakes up on every push or PR
event in a watched GitHub repo, runs the diff through a four-node LangGraph
(repo-context → reviewer → critic → arbiter/final), posts a structured
review comment, optionally auto-closes obvious bad PRs behind a three-gate
opt-in, mails a daily digest, and learns from the human's follow-up
behavior (reopens, reverts) by feeding those failures into a weekly
prompt-tuner that opens PRs proposing edits to its own `agent/prompt.md`.

Everything is observable through a public Next.js dashboard (overview,
per-PR detail, run history, repo stats, accuracy/learning, Sonnet-vs-Opus
benchmark). The agent never merges and never edits its own prompt without
a human approving the proposed PR.

---

## Current state — what v1 and v2 delivered

### v1 (Phases 0–5 of the original IMPROVEMENTS plan)

- **Monorepo restructure.** `agent/` (Python) and `dashboard/` (Next.js)
  live in one repo, with `.github/workflows/pr-review.yml` at the root
  because GitHub Actions requires workflows there. Vercel project's
  Root Directory is set to `dashboard/` so the Python files are never
  shipped to the edge.
- **Supabase replaces the GitHub Actions cache** for run/digest state.
  The original cache approach caused duplicate emails when the cache
  grew or got partially evicted; the fix was "use a real datastore",
  not "evict the cache better." See migration `001_initial_schema.sql`.
- **Daily digest pipeline.** `agent/send_digest.py` reads
  `digested_at IS NULL` rows, builds the HTML, sends via Gmail SMTP,
  inserts a `digests` row, then stamps `digested_at`. Order matters —
  digest row first so a partial failure leaves a recoverable trail.
- **Idempotency via PR-comment marker.** `<!-- lyncas:v1 -->`
  in the comment body is how `already_reviewed()` decides whether to
  skip on the next cron tick. Cheap, no extra storage, immune to
  Supabase outages, and the user can't accidentally make us re-review
  by tweaking the database.
- **Auto-close behind three gates.**
  `verdict == request_changes` AND `confidence == high` AND
  `severity_score >= 9`, plus the `ALLOW_AUTO_CLOSE` GitHub env var.
  Gates are AND-composed because each gate alone has a known failure
  mode (Claude inflating severity, low-confidence high-severity guesses
  on tiny diffs, etc.). The condition that would flip this:
  three months of `false_close_rate < 1%` and explicit human sign-off.
- **Sonnet-vs-Opus benchmark.** `agent/benchmark.py` re-runs an existing
  review through Opus (Sonnet is copied verbatim from the row, never
  re-run, so we don't confound the comparison with Sonnet's own
  run-to-run variance). Heuristic Jaccard on `(file + first 60 chars
  of issue)` decides "same bug." The benchmark page on the dashboard
  renders the metrics dynamically — no hardcoded "model X wins"
  conclusion.

### v2 (Phases 1–8 of IMPROVEMENTS_V2)

- **Switched the production model from Sonnet to Opus 4.5.** Benchmark
  showed 100% verdict agreement but low bug-list overlap on complex
  diffs — Opus finds different and more issues. The bug list IS the
  deliverable, so quality > cost here. We pay ~5× per token. The
  condition that would flip this back: monthly Anthropic spend exceeds
  a budget threshold AND the `/learning` accuracy gap between Opus and
  Sonnet narrows below benchmark-significance.
- **Per-repo fingerprints (Phase 2).** `agent/pr_reviewer.py`
  shallow-clones each watched repo once a week, asks Claude to write a
  ≤500-word summary (purpose, stack, key dirs, conventions,
  out-of-scope changes), caches it in `repo_fingerprints` for 7 days.
  Every review prompt prepends that fingerprint as `REPOSITORY CONTEXT`.
  Cache misses are the only path that pays the clone cost; cache hits
  are free. The tradeoff was "fingerprint vs full RAG index": the
  fingerprint gets ~80% of the value at ~10% of the complexity, and
  the entire fingerprint fits in the model's prompt budget without
  retrieval — which is the right call until we have evidence the
  reviewer is missing context the fingerprint can't cover.
- **Richer review comment + email (Phase 3).** Each bug now carries
  `file`, `line_hint`, `severity`, `issue`, `impact`, `suggestion`
  (often with a fenced code snippet), `reference`. The GitHub comment
  groups by severity. The digest card shows the top bug (with snippet
  + impact), a "context: yes/no" badge, and a per-card cost line.
- **Multi-repo + per-repo dashboard (Phase 4).** `REPOS` secret is
  comma-separated; the `/repos` page aggregates per-repo stats from
  the existing `reviews` rows in Python on read (no separate table).
- **GitHub webhook + Vercel function (Phase 5).** PR-opened/synchronize
  events POST to `dashboard/app/api/webhook/pull-request/route.ts`.
  **The webhook does NOT review the PR inline.** It HMAC-verifies the
  body, filters to `opened` / `synchronize`, and calls the GitHub
  Actions `workflow_dispatch` API to trigger the existing
  `pr-review.yml`. The 15-min cron stays as a safety net. The tradeoff
  was "single source of truth" — running the review in two places
  (Vercel function + GitHub Actions) would create webhook-only drift
  in prompt/parsing/auto-close logic. Vercel functions also have no
  git binary and a 10s execution budget; running inline was fighting
  the platform.
- **LangGraph (Phase 6).** `agent/review_graph.py` replaces the
  single-pass `review_pr_with_claude()` call. Four nodes:
  `repo_context` (Phase 8) → `reviewer` → `critic` → router →
  `arbiter` (only when `verdict differs` OR `|Δseverity| ≥ 2`) →
  `final`. The router is conditional precisely so we pay for an
  arbiter only when the first two passes disagree. Bug-list merging
  uses Jaccard ≥ 0.6 on issue tokens for same-file pairs (and exact
  `(file, line_hint)` match unconditionally) — tuned conservatively
  on the side of keeping a borderline-duplicate bug rather than
  silently dropping a real one.
- **Self-learning data layer (Phase 7).** `agent/track_human_actions.py`
  runs every 6 hours; for each ≤7-day-old review it polls the PR's
  current state on GitHub and classifies into five buckets:
  `agreement_close`, `false_close`, `agreement_approve`, `missed_issue`,
  `pending`. `false_close = agent closed + human reopened`;
  `missed_issue = agent commented + PR merged + revert commit on the
  base branch within 7 days`. Drift alerts fire when
  `false_close_rate > 5%` or `missed_issue_rate > 5%` over 30 days.
- **Multi-agent + prompt-tuner (Phase 8).** The `repo_context` agent
  was added in front of the reviewer (it distills the fingerprint
  down to the slice that matters for *this* diff so the reviewer's
  attention stays on bug-spotting). The prompt-tuner runs weekly,
  bundles every settled failure case from the last 30 days, asks
  Claude to rewrite `agent/prompt.md` based on that evidence,
  opens a PR against the agent repo. **The agent never merges its
  own PR.** A human must review every prompt change.

---

## v3 roadmap — in priority order

These items are pulled from IMPROVEMENTS_V2 § "What NOT to build yet"
and § "TODO.md additions (defer these)", plus the gaps we surfaced
while shipping Phase 8.

### 1. Re-review on new commits

- **What.** Today the agent bumps `<!-- lyncas:v1 -->` and
  never re-touches a PR after that. New commits land in the same PR
  without a refreshed review. Bump the marker version per `head_sha`
  so each push triggers exactly one review.
- **Why it matters.** Most PRs get pushed-to after the first review;
  every later commit currently flies blind. This is the single
  highest-leverage feature gap because it directly degrades the
  agent's usefulness on the longest-lived PRs.
- **Effort.** ~2 hrs. Change the marker to embed the head SHA
  (`<!-- lyncas:v1:<sha7> -->`), update `already_reviewed`
  to match prefix + sha, add a unique `(repo, pr_number, head_sha)`
  index on `reviews`.
- **Urgency condition.** Any week where ≥3 PRs in `human_actions`
  show `missed_issue` and the missed issue was introduced in a commit
  after the original review.

### 2. Rotate the Supabase legacy keys

- **What.** The Supabase anon + service_role keys leaked in a build
  chat transcript. Risk is currently low (demo dataset, public anon
  reads anyway, no PII), but service_role is full-DB-write.
- **Why it matters.** Low practical risk today; high reputational
  risk if/when the agent processes a real production repo.
- **Effort.** ~30 min. Rotate in Supabase → update `SUPABASE_URL` /
  `SUPABASE_SERVICE_KEY` GitHub secrets → update Vercel env →
  redeploy.
- **Urgency condition.** Any third party gets access to the agent
  repo, the dashboard URL becomes shareable, or a non-demo repo
  is added to `REPOS`.

### 3. Cost-budget alerts

- **What.** A scheduled job (or a check at the start of every
  `pr_reviewer.py` run) that sums `_input_tokens × $15/M +
  _output_tokens × $75/M` for Opus reviews in the current month
  and inserts an `agent_alerts` row when it crosses a threshold.
- **Why it matters.** Opus is ~5× per-token vs Sonnet. The current
  digest shows per-review cost but nothing aggregates monthly.
  One runaway loop or a giant-diff PR could spike the bill before
  anyone notices.
- **Effort.** ~1 hr. Reuse the `agent_alerts` table + the existing
  `MODEL_PRICING_USD_PER_M_TOKENS` constant; add a new `alert_type`.
- **Urgency condition.** Monthly spend climbs above $10 in a single
  month, or `REPOS` expands beyond two repos.

### 4. Ground-truth benchmark dataset

- **What.** 30–50 hand-labeled PRs (gold-standard bug list, gold
  verdict, gold severity) checked into the repo, plus a script that
  re-runs the agent on them and reports precision/recall on the bug
  list, verdict-match rate, and severity MAE. Replaces the single-shot
  Jaccard heuristic in `benchmark.py` with a stable benchmark we can
  use to gate prompt changes.
- **Why it matters.** The prompt-tuner currently estimates
  `accuracy_after_pct_estimate` by asking Claude itself. That's good
  enough to surface candidate changes but not to merge them blindly —
  we still need a human in the loop precisely because we have no
  independent ground truth. A real benchmark moves us toward
  evidence-based prompt changes.
- **Effort.** ~6 hrs (labeling is the slow part; tooling is small).
- **Urgency condition.** The first prompt-tuner PR lands and we
  realize we have no way to validate the change against anything
  except "the human had a good feeling about it."

### 5. Reasoning traces (Claude thinking blocks) stored per review

- **What.** When Anthropic's API supports `extended thinking` /
  thinking blocks for the production model, capture and persist the
  reasoning trace on the `reviews` row. Render it as a collapsible
  on `/pr/[id]`.
- **Why it matters.** Right now the agent's verdict is a black box.
  When the human disagrees, all we know is the final JSON — not why
  Claude reached it. Reasoning traces would let us debug the
  failure cases the prompt-tuner consumes.
- **Effort.** ~2 hrs (depends on Anthropic Python SDK support).
- **Urgency condition.** First false_close that the prompt-tuner
  can't explain.

### 6. Language-aware reviewer

- **What.** Detect Python vs TypeScript vs Go etc. from the diff
  and swap in language-specific concerns (e.g. "watch for missing
  `await` in async functions", "watch for unhandled error returns
  in Go"). Either by an extra graph node before the reviewer or by
  conditional prompt blocks.
- **Why it matters.** Reviews are currently language-agnostic; a TS
  reviewer would miss less language-specific stuff if it had a
  TS-specific concern list. The repo fingerprint already names the
  language, so this is mostly a prompt-engineering exercise.
- **Effort.** ~3 hrs. New file `agent/concerns/<lang>.md`,
  reviewer node reads the appropriate one based on the fingerprint.
- **Urgency condition.** `REPOS` expands beyond a single language.

### 7. Slack integration for critical auto-closes

- **What.** Whenever the agent closes a PR (action == "closed"),
  also POST a one-line Slack message with the PR link, severity,
  and verdict reason. Channel is configured via env var.
- **Why it matters.** The morning digest gives a 24-hour latency
  window on auto-closes; Slack would make them surface in seconds.
  Lower priority than the cost alerts because closes are rare and
  already labeled "review these first" in the digest.
- **Effort.** ~1 hr.
- **Urgency condition.** `ALLOW_AUTO_CLOSE=true` is turned on for
  the first time on a non-personal repo.

### 8. Supabase Auth on the dashboard

- **What.** Today `/`, `/pr/[id]`, `/runs`, `/repos`, `/learning`,
  `/benchmark`, `/settings` are all anonymously readable. Add an
  email-magic-link auth pass at the layout level, gated by a single
  `auth.users` row for the operator.
- **Why it matters.** Dashboard exposes every PR title we've ever
  reviewed plus token-level cost data; not a secret today, but the
  moment we share the URL with someone outside the project it
  becomes one.
- **Effort.** ~2 hrs. `@supabase/ssr` already in the bundle;
  middleware + a login page is most of the work.
- **Urgency condition.** Anyone outside the build chat gets the
  dashboard URL.

### 9. Inter-rater benchmark

- **What.** Have other reviewers grade the same PR sample the agent
  reviewed, compute Cohen's kappa between human reviewers AND between
  agent + each reviewer. Tells us if the agent is more or less
  consistent than the inter-rater baseline.
- **Why it matters.** "Agent and human disagree" might mean "the agent
  is wrong" OR "two humans would have disagreed too." Without an
  inter-rater baseline we'll always attribute disagreement to the
  agent.
- **Effort.** ~4 hrs (mostly people-coordination).
- **Urgency condition.** A reader of `/benchmark` asks "but is this
  agreement rate good?".

---

## Known limitations and technical debt

- **The webhook trigger pays for full cold-start every time.** The
  Vercel function dispatches a GitHub Actions workflow which then
  spins up an `ubuntu-latest` runner, installs pip deps, then
  finally runs the review. Median latency is ~60–90s, not the
  ~10s implied by IMPROVEMENTS_V2 Phase 5. The fix is either
  pre-warmed runner pools (paid) or running the review in the
  Vercel function inline — but the second one was deliberately
  ruled out (no `git`, 10s budget, would require duplicating the
  LangGraph in TypeScript).
- **`already_reviewed()` fetches up to 100 PR comments per check.**
  On long-lived PRs with many comments this is the slowest part of
  the agent. Could be cached on the `reviews` row but isn't.
- **`format_review_comment` does string splicing.** Each review
  posted to GitHub goes through a hand-rolled markdown builder. A
  small bug in the renderer can render an entire review as code or
  swallow a section. There are no tests.
- **`benchmark.py` is not in CI.** It's a manual one-off. The Sonnet
  side is read from the existing `reviews` row, so re-running it
  is cheap, but nothing alerts when verdict agreement drops.
- **The prompt-tuner's `accuracy_after_pct_estimate` is self-graded.**
  Claude looks at its own proposed change and guesses the resulting
  accuracy. Useful as a sanity-check, not as ground truth — see
  v3 item 4 above.
- **No retry on transient Anthropic errors.** A 5xx mid-review just
  fails that PR; the cron will catch it on the next tick. Acceptable
  today; will be annoying once `REPOS` grows.
- **The repo fingerprint cache is keyed on `repo`, not on
  `repo, commit_sha`.** A force-push to the default branch within
  the 7-day TTL leaves us with a stale summary. We track
  `commit_sha` for debuggability but don't invalidate on it.
- **The Supabase RLS policies are anon-read-only.** Writes only
  happen via the service_role key. There's no per-user data model
  because there are no users.
- **All migrations are sequential SQL files.** No idempotency on
  re-run (some use `if not exists`, some don't). There's no
  migration runner — applying is "open SQL editor, paste, run."
- **The dashboard has no error boundaries.** A failed Supabase
  query throws and renders Next's default error page.

---

## How to pick up where v2 left off

### Read first, in this order

1. **[CLAUDE.md](CLAUDE.md)** — the rules that must never be violated.
2. **[ARCHITECTURE.md](ARCHITECTURE.md)** — system diagram, component
   breakdown, data flow.
3. **`agent/pr_reviewer.py`** — the main loop. `main()` ties everything
   together; everything upstream is helpers.
4. **`agent/review_graph.py`** — the LangGraph. Read `ReviewState`,
   `_route_after_critic`, `run_review_graph` in that order.
5. **`agent/migrations/008_prompt_tuner_runs.sql`** — most recent
   migration; tells you the current schema state. Next migration is
   `009_*.sql`.
6. **`.github/workflows/pr-review.yml`** — four jobs, four crons.
   Understand what fires when before touching any of them.

### Validate the system is healthy before building

Run these in order. Each one should pass before you write a single
line of new code.

```sql
-- 1. Recent reviews are landing
select id, repo, pr_number, verdict, severity_score, created_at
from reviews
where created_at > now() - interval '7 days'
order by created_at desc
limit 10;

-- 2. Digests are stamping
select count(*) filter (where digested_at is null) as undigested,
       count(*) filter (where digested_at is not null) as digested,
       max(created_at) as latest_review
from reviews;

-- 3. Human-actions poller is alive
select action_type, count(*)
from human_actions
where observed_at > now() - interval '7 days'
group by action_type;

-- 4. No unresolved drift alerts
select alert_type, metric_value, threshold, raised_at
from agent_alerts
where resolved_at is null;

-- 5. Prompt-tuner runs have accurate status
select pr_number, status, status_observed_at
from prompt_tuner_runs
order by created_at desc
limit 5;
```

Then trigger a manual workflow_dispatch on `pr-review.yml` and watch
for "✅ posted" in the logs. Then run `python agent/benchmark.py
--latest 1` to confirm the Anthropic key still works and the
benchmark pipeline still writes to `benchmark_runs`.

If all five SQL checks return data and both manual runs succeed,
the system is healthy. Pick the top v3 roadmap item and start.
