# IMPROVEMENTS.md — Night PR Reviewer v2 (Monorepo)

> Pass this entire file to Claude Code in the `Night-PR-Reviewer` repo. Work through the phases in order. Do not skip ahead — each phase depends on the previous one.

---

## ⚠️ MONOREPO RESTRUCTURE (do this FIRST, before any phases)

The repo is being converted to a monorepo containing both the agent and the Next.js dashboard. This restructure happens **before Phase 1**.

### Target layout

```
Night-PR-Reviewer/
├── .github/
│   └── workflows/
│       └── pr-review.yml          # stays at repo root (GitHub requirement)
├── agent/
│   ├── pr_reviewer.py
│   ├── send_digest.py
│   ├── prompt.md
│   ├── requirements.txt
│   └── README.md                  # agent-specific docs
├── dashboard/                     # created in Phase 4
│   └── ...
├── README.md                      # top-level: explains the monorepo
├── IMPROVEMENTS.md
├── TODO.md
└── .gitignore                     # combined Python + Node.js patterns
```

### Restructure steps

1. **Create `agent/` directory** at repo root.
2. **Move existing files into `agent/`:**
   - `pr_reviewer.py` → `agent/pr_reviewer.py`
   - `send_digest.py` → `agent/send_digest.py`
   - `prompt.md` → `agent/prompt.md`
   - `requirements.txt` → `agent/requirements.txt`
3. **Do NOT move** `.github/workflows/pr-review.yml` — GitHub Actions requires workflows at the repo root. It stays where it is.
4. **Do NOT move** `README.md` — the existing README becomes the top-level monorepo README. Create a new `agent/README.md` for agent-specific docs.
5. **Update `.gitignore`** to cover both Python and Node.js:
   ```
   # Python
   __pycache__/
   *.pyc
   .venv/
   venv/
   .env

   # Node.js
   node_modules/
   .next/
   out/
   dist/
   .env.local
   .env*.local

   # IDE
   .vscode/
   .idea/
   .DS_Store
   ```

### Workflow file changes (MUST do as part of restructure)

The workflow file `.github/workflows/pr-review.yml` needs path updates everywhere it references the agent code:

```yaml
- name: Install deps
  run: pip install -r agent/requirements.txt   # was: requirements.txt

- name: Run PR reviewer
  env:
    # ... existing env vars ...
  run: python agent/pr_reviewer.py             # was: python pr_reviewer.py

- name: Send daily digest
  env:
    # ... existing env vars ...
  run: python agent/send_digest.py             # was: python send_digest.py
```

Also update the `setup-python` cache path:

```yaml
- uses: actions/setup-python@v5
  with:
    python-version: '3.11'
    cache: 'pip'
    cache-dependency-path: 'agent/requirements.txt'
```

### Validate the restructure before moving on

After restructuring, manually trigger the workflow (`workflow_dispatch`) and verify the agent still runs correctly. **Phase 1 does not start until the restructured agent passes a successful run.**

---

## Context

The current agent works but has a real bug: it stores run logs in the GitHub Actions cache, which keeps growing and causes duplicate emails. The fix is not "clear the cache better" — it's "use a real datastore." We're migrating state to Supabase and building a Next.js dashboard on top.

Current architecture:
- `agent/pr_reviewer.py` — runs in GitHub Actions, reviews open PRs, writes `logs/run-*.json` files
- `agent/send_digest.py` — reads all log files, emails an HTML digest
- Triggered by cron-job.org every 10 min hitting `workflow_dispatch`

Target architecture:
- `agent/pr_reviewer.py` — writes each review as a row in Supabase `reviews` table
- `agent/send_digest.py` — reads "reviews since last digest" from Supabase, sends one email, marks them as digested
- `dashboard/` — Next.js dashboard reading the same Supabase tables for live visualization
- No more `logs/` directory, no more GitHub Actions cache

---

## Phase 1 — Supabase schema (do this first, before touching code)

Set up the database. Do this in the Supabase web UI (project → SQL Editor) before changing any code.

### Tables

```sql
-- Each PR review the agent has done
create table reviews (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  repo            text not null,
  pr_number       int not null,
  pr_url          text not null,
  pr_title        text not null,
  pr_author       text,
  verdict         text not null check (verdict in ('approve','request_changes','comment')),
  confidence      text not null check (confidence in ('high','medium','low')),
  severity_score  int not null check (severity_score between 1 and 10),
  summary         text not null,
  bug_count       int not null default 0,
  bugs            jsonb,
  concerns        jsonb,
  questions       jsonb,
  praise          jsonb,
  action          text not null check (action in ('commented','closed')),
  gate_reason     text,
  input_tokens    int,
  output_tokens   int,
  digested_at     timestamptz,
  truncated       boolean default false
);

create unique index reviews_pr_unique on reviews(repo, pr_number);
create index reviews_digested_idx on reviews(digested_at) where digested_at is null;
create index reviews_created_idx on reviews(created_at desc);

-- Each run of the agent (for observability)
create table runs (
  id              uuid primary key default gen_random_uuid(),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  repos_scanned   text[],
  reviews_created int default 0,
  skipped         int default 0,
  errors          jsonb,
  trigger_source  text
);

create index runs_started_idx on runs(started_at desc);

-- Each digest email sent (for audit / dashboard)
create table digests (
  id              uuid primary key default gen_random_uuid(),
  sent_at         timestamptz not null default now(),
  review_ids      uuid[] not null,
  review_count    int not null,
  closed_count    int not null,
  subject         text not null,
  trigger_source  text
);
```

### RLS / Auth

For now: keep tables open with `service_role` access only. The agent writes with the service key. The dashboard reads with the anon key. Do NOT enable RLS yet — we'll add it in a future iteration.

### Environment

After creating the project, grab these from Supabase project settings → API:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY` (server-side, secret)
- `SUPABASE_ANON_KEY` (client-side, public — for dashboard)

Add `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` as **GitHub Actions secrets** in the `Night-PR-Reviewer` repo.

---

## Phase 2 — Migrate `agent/pr_reviewer.py` to write to Supabase

### Requirements

1. **Add `supabase>=2.0.0` to `agent/requirements.txt`** (path is inside `agent/` now).

2. **Replace file-based logging with DB writes.** Remove all `logs/` directory references, `LOG_DIR`, `run_log` dict, `run-*.json` files.

3. **At the start of `main()`**, insert a row into `runs` table, capture the returned `id`. Set `trigger_source` from env var `GITHUB_EVENT_NAME`.

4. **For each successfully reviewed PR**, insert a row into `reviews` with all structured fields. Use `upsert` on the `(repo, pr_number)` unique index so re-reviews overwrite cleanly.

5. **At the end of `main()`**, update the `runs` row with `finished_at`, `reviews_created`, `skipped`, and any errors.

6. **Keep the existing idempotency marker check** (`already_reviewed()` via GitHub API). Don't change review logic — only where state goes.

7. **Remove all log file writing.** Delete `LOG_DIR.mkdir()`, the `log_file.write_text(...)` call, the entire `run_log` accumulation.

8. **Error handling**: if a Supabase insert fails, log to stderr but don't crash the run. The review comment is already on GitHub at that point — losing the DB row is recoverable, losing the run is worse.

### Workflow file changes

Remove the cache restore/save steps for `logs/` from `.github/workflows/pr-review.yml`. Pass new env vars to the "Run PR reviewer" step:

```yaml
env:
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  GITHUB_TOKEN_PAT: ${{ secrets.PR_REVIEWER_PAT }}
  REPOS: ${{ secrets.REPOS }}
  ALLOW_AUTO_CLOSE: ${{ vars.ALLOW_AUTO_CLOSE || 'false' }}
  SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
  SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
  GITHUB_EVENT_NAME: ${{ github.event_name }}
```

Confirm `run: python agent/pr_reviewer.py`.

---

## Phase 3 — Migrate `agent/send_digest.py` to read from Supabase

### Requirements

1. **Replace `collect_recent_logs()` with `collect_undigested_reviews()`** that queries Supabase:
   ```python
   supabase.table('reviews').select('*').is_('digested_at', 'null').order('severity_score', desc=True).execute()
   ```

2. **Subject/body building stays the same.** Feed it data from Supabase instead of files.

3. **After successful email send:**
   - Insert a row into `digests` table with `review_ids`, `subject`, counts
   - Update all included `reviews` rows with `digested_at = now()`
   - In that order — record the digest first, then mark reviews

4. **Empty digest behavior:**
   - If `len(undigested) == 0` AND trigger is NOT the daily 7am UTC scheduled run, skip sending entirely
   - If empty AND it IS the 7am run, send the "all quiet" email (proof of life)
   - Detect via env var `GITHUB_EVENT_SCHEDULE`

5. **Remove all references to `LOG_DIR`, `logs/` files, `.digest-sent-*.marker` files.**

6. **Workflow env block for digest step**:
   ```yaml
   env:
     GMAIL_USER: ${{ secrets.GMAIL_USER }}
     GMAIL_APP_PASSWORD: ${{ secrets.GMAIL_APP_PASSWORD }}
     DIGEST_RECIPIENT: ${{ secrets.DIGEST_RECIPIENT }}
     SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
     SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
     GITHUB_EVENT_SCHEDULE: ${{ github.event.schedule }}
   ```
   Confirm `run: python agent/send_digest.py`.

### Sanity check

After Phase 3, the `logs/` directory concept is dead code. No file in `agent/` reads or writes `logs/`.

---

## Phase 4 — Next.js dashboard (in `dashboard/` folder of this monorepo)

Create the dashboard **inside** the existing `Night-PR-Reviewer` repo at `dashboard/`. Do NOT create a new GitHub repo.

### Initial setup

From the repo root:

```bash
npx create-next-app@latest dashboard \
  --typescript --tailwind --app --no-src-dir --import-alias "@/*"

cd dashboard
npm install @supabase/supabase-js @supabase/ssr recharts date-fns
```

This creates the `dashboard/` directory with the standard Next.js layout.

### Vercel deployment configuration (CRITICAL for monorepo)

When deploying to Vercel:

1. Import the `Night-PR-Reviewer` repo
2. In project settings → **General → Root Directory** → set to `dashboard`
3. Framework preset: Next.js (auto-detected once Root Directory is set)
4. Build command: `npm run build` (default)
5. Output directory: `.next` (default)

This tells Vercel to only build/deploy from the `dashboard/` subdirectory, ignoring the agent code entirely.

### Environment variables (in Vercel project settings)

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

### Pages

#### `/` — overview dashboard

Top section (stat cards in a 4-col grid):
- Total reviews (all time)
- Total auto-closed
- Average severity (last 30d)
- Estimated cost (Sonnet pricing: `(input_tokens * 3 + output_tokens * 15) / 1_000_000`, last 30d)

Middle section:
- **Recent reviews table**: repo, PR (linked to GitHub), title, verdict badge, severity badge, confidence, action, created_at
- Sortable by severity (default desc), created_at, repo
- Filterable by: repo, action, verdict, severity range
- Pagination, 25 rows per page

Bottom section:
- **Severity distribution** (Recharts horizontal bar, last 30d, bucketed 1-3 / 4-6 / 7-8 / 9-10)
- **Activity over time** (line chart, reviews per day, last 30d)

#### `/pr/[id]` — detail view

Full review: PR metadata, badges, summary, bugs as cards by severity, concerns/questions/praise as collapsibles, token usage + cost, action timestamp, related run.

#### `/runs` — agent run history

Table: started_at, finished_at, duration, repos_scanned, reviews_created, errors.

#### `/settings` — config viewer

Read-only display of watched repos, current model, auto-close gates. Hardcode for v1.

### Implementation notes

- **Server components for data fetching.** No client-side data fetching for initial page load — server-render everything.
- **No auth in v1.** Public dashboard URL. Lock down in v2.
- **No realtime in v1.** Page refresh on navigation is enough. Add Supabase realtime later if needed.
- **Styling**: match the email digest aesthetic — same palette, JetBrains Mono for code-like content, same severity colors (1-3 green, 4-6 amber, 7-8 orange, 9-10 red). Borrow colors from `agent/send_digest.py`.

### Dashboard internal structure

```
dashboard/
├── app/
│   ├── layout.tsx
│   ├── page.tsx
│   ├── globals.css
│   ├── pr/
│   │   └── [id]/
│   │       └── page.tsx
│   ├── runs/
│   │   └── page.tsx
│   └── settings/
│       └── page.tsx
├── components/
│   ├── ui/
│   │   ├── badge.tsx
│   │   ├── card.tsx
│   │   ├── stat-card.tsx
│   │   └── table.tsx
│   ├── reviews-table.tsx
│   ├── filters.tsx
│   ├── severity-chart.tsx
│   ├── activity-chart.tsx
│   └── pr-detail.tsx
├── lib/
│   ├── supabase/
│   │   ├── server.ts
│   │   └── client.ts
│   ├── queries.ts
│   ├── types.ts
│   └── utils.ts
├── public/
│   └── favicon.ico
├── .env.example
├── next.config.js
├── package.json
├── tailwind.config.ts
├── tsconfig.json
└── postcss.config.js
```

---

## Phase 5 — Validation checklist

After all phases complete, verify the system works end-to-end:

1. **Open a fresh PR** on a target repo
2. **Trigger the agent** (cron-job.org or manual workflow_dispatch)
3. **Check Supabase** — new `runs` row, new `reviews` row with `digested_at = null`
4. **Check the dashboard** (Vercel URL) — the review appears at the top of the table
5. **Trigger the agent again immediately** — no new review row (idempotency)
6. **Wait for the daily 7am digest** — should send email
7. **Check Supabase** — `digests` table has a new row, included reviews now have `digested_at` set
8. **Trigger another cron run** — digest does NOT send duplicate

### Common failure modes to test

- Supabase down during agent run → review comment still posted, error logged, run continues
- Supabase down during digest → digest aborts, no email sent
- Same PR triggers two parallel agent runs → upsert handles it, one row exists

---

## Phase 6 — Future work (do NOT implement now, note in TODO.md)

These are valid v3+ features but adding them before v2 is solid will compound bugs:

- GitHub webhook trigger (replaces cron-job.org, instant response on PR open)
- Re-review on new commits (bump idempotency marker version, store in reviews table)
- Per-repo config file (`night-pr-reviewer.yml` in target repos for severity threshold, model choice)
- Slack integration for critical-severity auto-close notifications
- Language-aware prompts (detect Python vs TypeScript vs Go, swap in language-specific concerns)
- Supabase Auth on the dashboard
- Cost budget alerts when monthly spend exceeds a threshold

Do not start any of these until Phases 0-5 are working and stable for at least a week.

---

## Working order — strict

Do not start Phase N until Phase N-1 is validated end-to-end:

0. **Monorepo restructure** → manually trigger workflow, confirm agent still runs from `agent/` paths
1. **Phase 1 (schema)** → run a manual `INSERT` in SQL editor to confirm tables work
2. **Phase 2 (agent migration)** → trigger workflow, see a row in `reviews`
3. **Phase 3 (digest migration)** → trigger digest, see `digested_at` populate and `digests` row appear
4. **Phase 4 (dashboard)** → only when Phases 2 and 3 are both green

Validate each phase. Commit each phase as a separate PR with a clear title. Don't bundle.

---

## Top-level `README.md` update

After the restructure, replace the existing top-level `README.md` content with a monorepo overview:

```markdown
# Night PR Reviewer

Autonomous agent that reviews open PRs on configured GitHub repos every 10 minutes
and emails a daily digest. Includes a Next.js dashboard for visualization.

## Structure

- `agent/` — Python agent (runs in GitHub Actions, writes to Supabase)
- `dashboard/` — Next.js dashboard (deployed on Vercel, reads from Supabase)
- `.github/workflows/` — GitHub Actions workflow that runs the agent

## Quick links

- Agent docs: [agent/README.md](agent/README.md)
- Dashboard docs: [dashboard/README.md](dashboard/README.md)
- Improvements / roadmap: [IMPROVEMENTS.md](IMPROVEMENTS.md)
```

Move the original setup/deployment instructions to `agent/README.md`.
