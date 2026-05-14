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
