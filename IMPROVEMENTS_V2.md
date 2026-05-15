# IMPROVEMENTS_V2.md — Night PR Reviewer

> Pass this file to Claude Code phase by phase. Complete and validate each phase before starting the next. Do not bundle phases.

---

## Why this order

1. **Opus first** — 1-line change, everything else benefits from it immediately
2. **Repo context** — foundation that makes all subsequent reviews smarter
3. **Better reviews + email** — now powered by Opus + context, max quality gain
4. **More repos + dashboard stats** — observability across the expanded surface
5. **Webhooks** — instant response now that the review quality justifies it
6. **LangGraph** — structured orchestration foundation before adding agents
7. **Self-learning** — needs LangGraph graph structure to slot in cleanly
8. **Multi-agent** — plugs into the graph built in Phase 6

---

## Phase 1 — Switch to Opus (5 min)

### What it does
Switches the review model from `claude-sonnet-4-5` to `claude-opus-4-5`. The benchmark showed verdict agreement is 100% between models but bug overlap is low — Opus finds different (and more) issues. Since the bug list goes into the digest email, quality matters.

### Scope

1. In `agent/pr_reviewer.py`, change:
   ```python
   MODEL = "claude-sonnet-4-5"
   ```
   to:
   ```python
   MODEL = "claude-opus-4-5"
   ```

2. Update the model constant comment to explain the decision:
   ```python
   # claude-opus-4-5: ~5x cost of Sonnet but meaningfully better bug detection.
   # Benchmark (n=5) showed 100% verdict agreement but low bug overlap on complex PRs.
   # For deep review where the bug list IS the deliverable, Opus wins.
   # Switch back to Sonnet if monthly cost exceeds budget threshold.
   ```

3. Update `agent/README.md` model section to reflect the change and the benchmark rationale.

### Validation
- Push, trigger `workflow_dispatch`
- Confirm the run log shows `claude-opus-4-5` in the model field
- Check Supabase: the new review row's `input_tokens` will be higher than Sonnet reviews (expected — Opus is more verbose)
- Run `python benchmark.py --latest 5` to update the benchmark page with fresh data

### Commit
`feat(agent): switch model to claude-opus-4-5 based on benchmark findings`

---

## Phase 2 — Repo context + caching (60-75 min)

### What it does
Right now the agent only sees the diff. It has zero knowledge of what the repo IS — its purpose, stack, conventions, architecture. A well-written React component dropped into a Python backend repo scores "clean." Repo context fixes this.

The fingerprint is generated once per repo (via git clone), stored in Supabase, and refreshed weekly. Every subsequent review reads from cache — no clone overhead.

### Schema addition

Run in Supabase SQL Editor:

```sql
create table repo_fingerprints (
  id              uuid primary key default gen_random_uuid(),
  repo            text not null unique,
  fingerprint     text not null,        -- compact summary: purpose, stack, key dirs, conventions
  last_updated    timestamptz not null default now(),
  commit_sha      text,                  -- SHA at time of fingerprint generation
  token_count     int                    -- rough size of the fingerprint for cost tracking
);

create index repo_fingerprints_repo_idx on repo_fingerprints(repo);
alter table repo_fingerprints enable row level security;
create policy "anon read repo_fingerprints" on repo_fingerprints for select using (true);
```

### Agent changes (`agent/pr_reviewer.py`)

1. **Add `get_or_refresh_fingerprint(repo, github_token, supabase_client)` function:**
   - Check Supabase for existing fingerprint where `repo = repo` AND `last_updated > now() - interval '7 days'`
   - If exists: return cached fingerprint (no clone)
   - If missing or stale:
     - `git clone --depth=1 https://<token>@github.com/<repo>.git /tmp/<repo-slug>` into a temp dir
     - Read: `README.md` (first 3000 chars), `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` (whichever exists), top-level directory listing (2 levels deep)
     - Call Claude with a summarizer prompt (see below) to generate a compact fingerprint
     - Store in Supabase `repo_fingerprints` table
     - Delete the temp clone (`shutil.rmtree`)
     - Return the fingerprint

2. **Summarizer prompt** (hardcode this, not in `prompt.md`):
   ```
   You are summarizing a software repository for use as context in code reviews.
   Given the README, dependency file, and directory structure below, produce a
   compact summary (max 500 words) covering:
   - What this project does (1-2 sentences)
   - Tech stack (languages, frameworks, key dependencies)
   - Key directories and what they contain
   - Conventions you can infer (naming patterns, test locations, config approach)
   - What kinds of changes would be OUT OF SCOPE for this repo

   Be specific and factual. Do not add opinions or suggestions.
   ```

3. **Inject fingerprint into the review prompt:**
   - In the existing review call, prepend the fingerprint to the user message:
     ```
     REPOSITORY CONTEXT:
     <fingerprint here>

     ---
     PR DIFF:
     <diff here>
     ```
   - If fingerprint generation fails, log a warning and continue without it (graceful degradation)

4. **Add `GITHUB_TOKEN_PAT` to the clone URL** — already in env, just use it for the clone auth.

5. **Workflow changes:** No new secrets needed. Add `git` availability check in the workflow (ubuntu-latest has it by default).

### Validation
```bash
# Run locally — first run should clone, second should use cache
python pr_reviewer.py  # (or trigger via workflow_dispatch twice)

# Check Supabase
select repo, length(fingerprint) as chars, last_updated, commit_sha
from repo_fingerprints;
# Expect: 1 row per repo, fingerprint is 200-500 words
```

- Trigger workflow twice on the same repo — second run should log "using cached fingerprint" and be ~30 sec faster
- Check a new review row: the `summary` field in Supabase should now reference repo-specific context (e.g., mentions the framework by name)

### Commit
`feat(agent): add repo fingerprint context with weekly cache refresh`

---

## Phase 3 — Better reviews + more descriptive email (45-60 min)

### What it does
The current review comment is functional but sparse. This phase makes it match CodeRabbit's quality: structured sections, inline code references, severity-grouped bugs, actionable suggestions. The email digest gets a matching upgrade.

### Changes to `agent/prompt.md`

Rewrite the output format section to require:

```
For each bug/concern, the agent MUST provide:
- file: the exact file path (or "multiple files")
- line_hint: line number or range if visible in the diff (null if not determinable)
- severity: critical / high / medium / low
- issue: one sentence describing what is wrong
- impact: one sentence describing what could go wrong if unfixed
- suggestion: concrete fix with a code snippet if possible (max 10 lines)
- reference: a relevant doc/RFC/CVE link if applicable (null if none)
```

The review comment posted to GitHub should be formatted as:

```markdown
## 🌙 Night PR Reviewer

**Verdict:** [APPROVE / REQUEST CHANGES / COMMENT]
**Severity:** [score]/10 · **Confidence:** [high/medium/low]

> [one-sentence summary of the PR's purpose and overall quality]

---

### 🐛 Bugs ([count])

#### [severity emoji] [issue title] — `[file]:[line]`
[issue description]

**Impact:** [impact]

**Suggested fix:**
```[language]
[code snippet]
```

---

### ⚠️ Concerns ([count])
[concerns list]

### ❓ Questions ([count])
[questions list]

### ✅ Praise ([count])
[praise list]

---
*Reviewed by [model] · [input_tokens] in / [output_tokens] out · $[cost]*
*[Repo context: cached / fresh / unavailable]*
```

### Changes to `agent/send_digest.py`

Update the HTML email template to:
- Show the code snippet for the top bug in each review card (syntax highlighted via `<pre><code>`)
- Show impact statement under each bug
- Add a "Repo context used" badge on each card (yes/no)
- Add a cost-per-review line in the card footer
- Add a weekly summary section at the top: total reviews, total closed, total bugs flagged across all reviews, total cost

### Validation
- Open a fresh PR, trigger the workflow
- Check the GitHub PR page — the review comment should match the new format with code snippets and impact statements
- Trigger a digest, check the email — cards should show the richer format

### Commit
`feat(agent): richer review comments and email digest format`

---

## Phase 4 — More repos + per-repo dashboard stats (45 min)

### What it does
Adds multiple target repos to the agent and surfaces per-repo breakdowns on the dashboard.

### Agent changes

The `REPOS` secret already supports comma-separated repos. No agent code changes needed — just update the secret value in GitHub Actions to include additional repos.

### Dashboard changes (`dashboard/`)

1. **New `/repos` page:**
   - Table: repo name (linked to GitHub), total reviews, total closed, avg severity, est. cost (30d), last reviewed
   - Click a repo → filtered overview showing only that repo's reviews

2. **Update `/` overview:**
   - Add a "By repo" breakdown section below the main stats
   - Small table: repo, review count, closed count, avg severity

3. **Queries to add in `dashboard/lib/queries.ts`:**
   ```typescript
   getRepoStats(): Promise<RepoStat[]>
   // { repo, total_reviews, total_closed, avg_severity, estimated_cost_usd, last_reviewed_at }
   ```

4. **Nav update:** Add `/repos` link between `overview` and `runs`.

5. **`RepoStat` interface** in `dashboard/lib/types.ts`.

### Validation
- Add a second repo to the `REPOS` GitHub secret (comma-separated)
- Trigger the workflow — both repos should be scanned
- Open `/repos` on the dashboard — both repos should appear with their stats
- Click a repo — filtered view should show only that repo's reviews

### Commit
`feat(dashboard): add per-repo stats page and breakdown`

---

## Phase 5 — Webhooks + Vercel Functions (75 min)

### What it does
Replaces the 10-minute polling cron with an instant GitHub webhook. When a PR is opened or updated, GitHub calls a Vercel Function which runs the review immediately. Response time drops from ~5 min average to ~5-10 seconds.

The cron stays as a fallback — if the webhook misses an event (network blip, Vercel outage), the cron catches it on the next tick.

### New file: `dashboard/app/api/webhook/pull-request/route.ts`

```typescript
// POST /api/webhook/pull-request
// Called by GitHub on PR open / synchronize events
// Verifies HMAC-SHA256 signature, triggers review inline
```

Requirements:
1. Verify `X-Hub-Signature-256` header using `WEBHOOK_SECRET` env var (HMAC SHA256 of the raw body). Return 401 if invalid.
2. Parse payload — only process `action: "opened"` or `action: "synchronize"`. Return 200 immediately for all other events.
3. Extract `repo.full_name`, `pull_request.number`, `pull_request.html_url`, `pull_request.title`, `pull_request.user.login`
4. Port the review logic from `agent/pr_reviewer.py`:
   - Check `already_reviewed()` via GitHub API — if true, return 200 with `{ skipped: true }`
   - Fetch the diff
   - Get or refresh repo fingerprint from Supabase
   - Call Claude (Opus) with `prompt.md` system prompt
   - Parse JSON response
   - Apply three-gate auto-close logic
   - Post review comment to GitHub
   - Upsert row into Supabase `reviews` table
5. Return 200 with a summary JSON on success, 500 with error detail on failure
6. All errors must be caught and logged — never let an uncaught exception crash the function

### New env vars for dashboard (add to Vercel + `dashboard/.env.example`)
```
WEBHOOK_SECRET=
ANTHROPIC_API_KEY=
PR_REVIEWER_PAT=
SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_KEY=
```

### GitHub webhook configuration (manual step)
1. Target repo → Settings → Webhooks → Add webhook
2. Payload URL: `https://[your-vercel-url]/api/webhook/pull-request`
3. Content type: `application/json`
4. Secret: generate a strong random string, add to Vercel env as `WEBHOOK_SECRET`
5. Events: "Pull requests" only
6. Active: yes

### Validation
- Open a fresh PR on the target repo
- Watch Vercel function logs (Vercel dashboard → Functions → `webhook/pull-request`)
- Review comment should appear on the PR within 10 seconds
- Confirm new row in Supabase `reviews`
- Confirm idempotency: push a new commit to the same PR → if already_reviewed, should skip

### Commit
`feat(dashboard): add GitHub webhook handler for instant PR review`

---

## Phase 6 — LangGraph review loop (120 min)

### What it does
Replaces the single LLM call with a structured multi-node graph. Instead of one pass, the review goes through:

```
diff + context → [Reviewer Node] → [Critic Node] → router → [Final Node]
                                                  ↘ (if disagree) → [Arbiter Node]
```

- **Reviewer Node**: standard review pass (same as current)
- **Critic Node**: adversarial pass — "what did the reviewer miss or get wrong?"
- **Router**: if verdict or severity disagrees by ≥2, escalate to Arbiter
- **Arbiter Node**: third independent pass with both previous outputs as context, makes final call
- **Final Node**: merges outputs, builds the structured comment

This catches single-pass blind spots and gives the agent internal self-correction before posting.

### New file: `agent/review_graph.py`

```python
from langgraph.graph import StateGraph, END
from typing import TypedDict

class ReviewState(TypedDict):
    # Input
    repo: str
    pr_number: int
    pr_url: str
    diff: str
    repo_fingerprint: str | None

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
```

Nodes:
1. `reviewer_node` — current review logic, writes to `reviewer_output`
2. `critic_node` — runs review with adversarial system prompt ("Your job is to challenge the reviewer's findings. What did they miss? What did they over-flag? Return the same JSON schema."), writes to `critic_output`
3. `router` — compares `reviewer_output` and `critic_output`. If `verdict` differs OR `abs(severity_reviewer - severity_critic) >= 2`: route to `arbiter_node`. Otherwise: route to `final_node`.
4. `arbiter_node` — receives both outputs as context, makes independent final call, writes to `arbiter_output`
5. `final_node` — picks the final verdict/severity (arbiter if escalated, reviewer otherwise), merges bug lists (union, deduplicated by Jaccard), builds the GitHub comment

### Schema addition for Supabase

```sql
alter table reviews
  add column critic_output  jsonb,
  add column arbiter_output jsonb,
  add column escalated      boolean default false;
```

### Dashboard addition

On `/pr/[id]`, add a collapsible "Agent deliberation" section showing:
- Reviewer's original verdict + severity
- Critic's challenge (what it flagged as missed/wrong)
- Whether escalation happened + arbiter's final call
- This is the most compelling demo surface — watching the agent debate itself

### New dependency
```
langgraph>=0.2.0
```
Add to `agent/requirements.txt`.

### Validation
- Trigger a workflow run, check the log for all three node outputs
- Check Supabase: new review row should have `critic_output` populated, `escalated` true/false
- Open `/pr/[id]` — deliberation section should show the reviewer vs critic debate

### Commit
`feat(agent): replace single LLM call with LangGraph reviewer-critic-arbiter graph`

---

## Phase 7 — Self-learning data layer (90 min)

### What self-learning achieves

Without it: the agent runs blind. It never knows if its decisions were right. It can't improve.

With it:
- **Ground truth from your behavior** — every PR you reopen (false close) or approve that gets reverted (missed issue) becomes labeled feedback
- **Drift detection** — models degrade silently over time on new patterns. A 5% false-close rate threshold catches this before it compounds
- **Prompt improvement loop** — failures drive specific, evidence-based prompt changes instead of "tune until it feels better"
- **Justifiable autonomy** — an agent that can prove its accuracy improves over time earns more trust than one that can't

### Schema addition

```sql
create table human_actions (
  id              uuid primary key default gen_random_uuid(),
  review_id       uuid not null references reviews(id) on delete cascade,
  observed_at     timestamptz not null default now(),
  action_type     text not null check (action_type in (
    'agreement_close',
    'false_close',
    'agreement_approve',
    'missed_issue',
    'pending'
  )),
  pr_state        text not null,
  reopened        boolean default false,
  merged          boolean default false,
  reverted        boolean default false,
  poll_count      int default 0,
  notes           text
);

create unique index human_actions_review_unique on human_actions(review_id);
create index human_actions_type_idx on human_actions(action_type);
create index human_actions_pending_idx on human_actions(action_type)
  where action_type = 'pending';

alter table human_actions enable row level security;
create policy "anon read human_actions" on human_actions
  for select using (true);
```

### New file: `agent/track_human_actions.py`

Behavior:
1. Query all reviews < 7 days old where `human_actions` row is missing or `action_type = 'pending'`
2. For each review, query GitHub API for current PR state
3. Classify:
   - Agent closed + PR reopened → `false_close`
   - Agent closed + PR still closed → `agreement_close`
   - Agent commented + PR merged → `agreement_approve`
   - Agent commented + PR merged + revert commit within 7d → `missed_issue`
   - Anything else → `pending`
4. Upsert into `human_actions`
5. After the polling loop, compute drift:
   - `false_close_rate = false_closes / total_closes (last 30d)`
   - `missed_issue_rate = missed_issues / total_approves (last 30d)`
   - If either > 5%, insert a row into `agent_alerts` table

### New table: `agent_alerts`

```sql
create table agent_alerts (
  id              uuid primary key default gen_random_uuid(),
  raised_at       timestamptz not null default now(),
  alert_type      text not null,
  metric_value    numeric not null,
  threshold       numeric not null,
  resolved_at     timestamptz
);

alter table agent_alerts enable row level security;
create policy "anon read agent_alerts" on agent_alerts
  for select using (true);
```

### Workflow addition

Add a new scheduled job to `.github/workflows/pr-review.yml`:

```yaml
poll-human-actions:
  runs-on: ubuntu-latest
  if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-python@v5
      with:
        python-version: '3.11'
        cache: 'pip'
        cache-dependency-path: 'agent/requirements.txt'
    - run: pip install -r agent/requirements.txt
    - name: Poll human actions
      env:
        SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
        SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
        GITHUB_TOKEN_PAT: ${{ secrets.PR_REVIEWER_PAT }}
      run: python agent/track_human_actions.py
```

Schedule this job every 6 hours: `0 */6 * * *`

### Dashboard additions

1. **New `/learning` page:**
   - Accuracy stat: `(agreement_close + agreement_approve) / total non-pending × 100%`
   - Line chart: accuracy over time (last 90 days)
   - Table of recent `false_close` and `missed_issue` cases — these drive prompt improvements
   - Alert banner if any unresolved `agent_alerts` row exists
   - Disclaimer: "Prompt-improvement suggestions are queued for v3"

2. **On `/pr/[id]`:** Add "Human verdict" section showing `action_type` badge + `observed_at` + `notes`

3. **On `/` overview:** Add 5th stat card: "Agent accuracy (30d)"

4. **Nav:** Add `/learning` link

5. **Queries to add:**
   - `getHumanAction(reviewId): Promise<HumanAction | null>`
   - `getAccuracyStats(days): Promise<AccuracyStats>`
   - `getRecentMisses(limit): Promise<HumanAction[]>`
   - `getAgentAlerts(): Promise<AgentAlert[]>`

### Validation
- Run `python track_human_actions.py` locally
- Check Supabase: `human_actions` rows appear for existing reviews
- Open `/learning` — accuracy stat and table render
- Open `/pr/[id]` — human verdict section shows

### Commit
`feat(agent): add self-learning data layer with human action tracking and drift detection`

---

## Phase 8 — Multi-agent orchestration (120 min)

### What it does
Extends the LangGraph graph from Phase 6 with two additional specialized agents, completing the multi-agent architecture.

```
diff + context
  → [Repo Context Agent]     (understands the codebase)
  → [Reviewer Agent]         (reads the diff)
  → [Critic Agent]           (challenges the reviewer)
  → router
      ↘ (disagree) → [Arbiter Agent]   (makes final call)
  → [Final Node]             (builds the comment)

Async / background:
  → [Prompt Tuner Agent]     (weekly, proposes prompt.md improvements)
```

### New agents

**Repo Context Agent** (slots into graph before Reviewer):
- Reads `repo_fingerprints` from Supabase
- Extracts the most relevant context for this specific diff (which directories, which conventions apply)
- Writes a `diff_specific_context` field to `ReviewState`
- The Reviewer receives this as additional context

**Prompt Tuner Agent** (runs as a separate scheduled job, not inline):
- Queries last 30 days of `human_actions` where `action_type IN ('false_close', 'missed_issue')`
- Bundles the review, the diff, and the human verdict for each failure case
- Calls Claude with a meta-prompt: "Given these N cases where the agent was wrong, propose specific edits to the system prompt below. Return a unified diff."
- Opens a PR against the `Night-PR-Reviewer` repo with:
  - The proposed `prompt.md` diff
  - A table of the N failure cases that drove the suggestion
  - Accuracy before vs projected accuracy after (rough estimate)
- **Agent NEVER merges its own PR.** Human review required.

### State schema additions

```python
class ReviewState(TypedDict):
    # ... existing fields ...
    diff_specific_context: str | None    # from Repo Context Agent
    prompt_tuner_suggestions: list | None  # populated by Prompt Tuner Agent (async)
```

### Dashboard additions

On `/learning`:
- New section: "Pending prompt improvements" — lists any open PRs from the Prompt Tuner Agent against the agent repo
- Each entry shows the failure cases that drove it + the proposed diff

### New dependency
No new dependencies — LangGraph already installed in Phase 6.

### Validation
- Trigger a workflow run — check logs for all 4 inline agent nodes firing in order
- Trigger the Prompt Tuner manually (if enough `human_actions` data exists)
- Check the agent repo on GitHub — a new PR should appear with the proposed prompt diff
- DO NOT merge the PR automatically — review it manually first

### Commit
`feat(agent): add repo-context and prompt-tuner agents to LangGraph graph`

---

## Working order — strict

| Phase | Estimated time | Validates when |
|---|---|---|
| 1 — Opus | 5 min | Workflow runs green with Opus model string |
| 2 — Repo context | 60-75 min | Two workflow runs: first clones, second uses cache |
| 3 — Better reviews | 45-60 min | PR comment matches new format, email shows code snippets |
| 4 — More repos | 45 min | Two repos appear on /repos dashboard page |
| 5 — Webhooks | 75 min | PR review appears within 10 sec of opening PR |
| 6 — LangGraph | 120 min | Supabase shows critic_output populated on new reviews |
| 7 — Self-learning | 90 min | /learning page renders with real accuracy data |
| 8 — Multi-agent | 120 min | All 4 nodes fire in logs, Prompt Tuner opens a PR |

**Total: ~9-10 hours across multiple sessions. Do not try to do all phases in one night.**

---

## What NOT to build yet

These are valid ideas but premature without more data:

- Quarterly prompt-tuner (needs 50+ `human_actions` rows before it has signal)
- RAG-based repo indexing (fingerprint approach gets 80% of the value at 10% of the complexity)
- Email reply commands (clever but low-ROI until multi-repo usage)
- Public GitHub Action for others to install (stabilize the core first)
- Supabase Auth on dashboard (add when you share the URL with others)

---

## TODO.md additions (defer these)

- Rotate Supabase legacy anon + service_role keys (leaked in build chat, low practical risk on demo data)
- PR re-review on new commits (bump idempotency marker version)
- Slack integration for critical-severity auto-close notifications
- Ground-truth benchmark dataset (30-50 hand-labeled PRs, real evaluation methodology)
- Cost budget alerts (monthly spend threshold)
- Reasoning traces stored per review (Claude thinking blocks)
- Language-aware prompts (detect Python vs TypeScript vs Go)
- Inter-rater benchmark (other interns grade same PRs, compute agreement)
