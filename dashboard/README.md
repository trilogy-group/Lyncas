# dashboard

Next.js (App Router) dashboard for the `lyncas` agent. Reads
review/run/digest rows from the same Supabase project that the agent writes
to, renders an overview page with stat cards + filterable/sortable reviews
table + two charts, plus per-PR detail, run history, and a read-only
settings view. Designed to mirror the email digest's aesthetic.

## Stack

- Next.js 16 (App Router, React 19, Server Components)
- TypeScript 5
- Tailwind CSS v4 (theme tokens in `app/globals.css`)
- `@supabase/ssr` + `@supabase/supabase-js`
- Recharts (for the two summary charts on `/`)

## Local development

From the repo root:

```bash
cd dashboard
npm install
cp .env.example .env.local
# fill in NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
npm run dev
```

Then visit [http://localhost:3000](http://localhost:3000).

The dashboard is read-only (anon key) and has no auth in v1 — any PR review
that has landed in the `reviews` table will appear immediately.

### Where to get the env vars

In your Supabase project → Settings → API:

- `NEXT_PUBLIC_SUPABASE_URL` → "Project URL"
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` → "Project API keys" → `anon` / public key

Do **not** put the `service_role` key here. That key has full DB access and
must only live in the agent's GitHub Actions secrets.

## Project layout

```
dashboard/
├── app/
│   ├── layout.tsx           top nav + fonts + globals
│   ├── page.tsx             /  — overview (stats, filters, table, charts)
│   ├── pr/[id]/page.tsx     /pr/<uuid> — review detail
│   ├── runs/page.tsx        /runs — agent run history
│   ├── settings/page.tsx    /settings — read-only config
│   └── globals.css          tailwind v4 theme tokens
├── components/
│   ├── ui/                  badge, card, stat-card, table — primitives
│   ├── nav.tsx              top navigation bar
│   ├── reviews-table.tsx    home page table (server component)
│   ├── filters.tsx          URL-state filter bar ('use client')
│   ├── severity-chart.tsx   horizontal bar ('use client', Recharts)
│   ├── activity-chart.tsx   line chart ('use client', Recharts)
│   └── pr-detail.tsx        /pr/[id] body
├── lib/
│   ├── types.ts             interfaces matching agent/migrations/001*.sql
│   ├── design.ts            palette + severityColor/verdictBadge/format*
│   ├── queries.ts           all Supabase reads (server-only)
│   └── supabase/
│       ├── server.ts        createServerClient (used by every page)
│       └── client.ts        createBrowserClient (unused in v1, kept for future)
└── .env.example
```

Filter and pagination state lives entirely in URL search params (e.g.
`/?repo=foo/bar&verdict=request_changes&sortBy=severity_score&page=2`), so
every dashboard view is bookmarkable.

## Production deploy (Vercel)

1. Import the `Lyncas` repo on Vercel.
2. **Project settings → General → Root Directory** → set to `dashboard`.
   This tells Vercel to ignore the `agent/` Python code and only build the
   Next.js app.
3. Framework preset: Next.js (auto-detected once Root Directory is set).
4. Build command: `npm run build` (default).
5. Output directory: `.next` (default).
6. **Project settings → Environment Variables** (apply to Production +
   Preview + Development) → add:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
7. Click Deploy. First build takes ~2 minutes.

## Benchmark

`/benchmark` is a Sonnet-vs-Opus comparison page. For every row in the
`benchmark_runs` Supabase table it shows:

- summary stats (verdict agreement %, mean severity delta, mean bug
  overlap %, cost ratio)
- a methodology blurb (so the page isn't taken as more authoritative
  than it is)
- the per-PR comparison rows, each clickable to drill down into
  Sonnet's bugs vs Opus's bugs side-by-side with matched/unique
  highlighting and both summaries verbatim
- a conclusion that is rendered dynamically from the data — there is
  no hardcoded "model X wins"

Populate the table by running the benchmark script against the same
Supabase project:

```bash
cd agent
python benchmark.py --latest 5
# or, against specific reviews:
python benchmark.py --review-ids <uuid>,<uuid>
```

The page handles the empty state (no rows yet) by telling you to run
the command above. The conclusion only renders once there is data.

## Webhook (workflow dispatcher)

`POST /api/webhook/pull-request` is the GitHub webhook receiver. It does
**not** run the review inline. Instead, it verifies the HMAC-SHA256
signature, filters to `opened` / `synchronize` events, and immediately
triggers the agent's `pr-review.yml` GitHub Actions workflow via the
`workflow_dispatch` API. The agent then runs the same LangGraph pipeline
in CI that the cron schedule already runs.

This means **all reviews use the same LangGraph pipeline regardless of
trigger source** — there is exactly one place where reviews are produced
(the agent in CI), and the webhook is just a low-latency way to wake it
up. The 15-min cron stays in place as a safety net for any missed
delivery.

Required env vars on Vercel:

- `WEBHOOK_SECRET` — random string also pasted into the GitHub webhook
  "Secret" field.
- `AGENT_WORKFLOW_PAT` — fine-grained PAT with `actions: write` on the
  agent repo. **Distinct from** the agent-side `PR_REVIEWER_PAT` (used by
  the Python script to fetch diffs and post comments on the target
  repos); a fine-grained PAT can only access repos owned by the account
  that created it, so when the agent repo and the target repos live
  under different accounts you need one PAT per account.
- `AGENT_REPO` — `<owner>/<repo>` of the agent repo (the one that hosts
  `pr-review.yml`), e.g. `trilogy-group/Lyncas`. **Not** the
  repo a PR was opened against.

Optional overrides:

- `AGENT_WORKFLOW` (default `pr-review.yml`)
- `AGENT_WORKFLOW_REF` (default `main`)

GitHub webhook setup on each target repo: Settings → Webhooks → Add
webhook → payload URL `https://<your-vercel-url>/api/webhook/pull-request`,
content type `application/json`, paste the same `WEBHOOK_SECRET`, select
the "Pull requests" event only.

## Notes

- Every page is `export const dynamic = "force-dynamic"` because the data
  comes from a live Supabase query. No build-time pre-rendering.
- No auth in v1 — public dashboard URL. Add Supabase Auth in a later
  iteration if you need access control.
- No realtime in v1 — refresh to pick up new reviews. Wire up Supabase
  realtime channels later if the latency becomes annoying.
