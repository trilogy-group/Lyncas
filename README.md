# Night PR Reviewer

Autonomous agent that reviews open PRs on configured GitHub repos every 10 minutes
and emails a daily digest. Includes a Next.js dashboard for visualization.

## v2 features



- Supabase-backed state for reviews, runs, and digests
- Next.js dashboard with stats, filters, charts, and per-PR detail views
- Sonnet-vs-Opus benchmark page (`/benchmark`) — re-runs the same prompt on real PR diffs through both models and shows agreement, severity delta, bug overlap, and cost ratio with a methodology blurb and a data-driven conclusion

## Structure

- `agent/` — Python agent (runs in GitHub Actions, writes to Supabase)
- `dashboard/` — Next.js dashboard (deployed on Vercel, reads from Supabase)
- `.github/workflows/` — GitHub Actions workflow that runs the agent

## Quick links

- Agent docs: [agent/README.md](agent/README.md)
- Dashboard docs: [dashboard/README.md](dashboard/README.md)
- Forward-looking plan, v3 roadmap, and technical debt: [PROJECT_PLAN.md](PROJECT_PLAN.md)
- System architecture reference (diagrams, components, schema, env vars): [ARCHITECTURE.md](ARCHITECTURE.md)
- Rules for AI assistants (Claude Code / Cursor) picking up this project: [CLAUDE.md](CLAUDE.md)
