# OpenClaw Migration

_Started 2026-05-15. Goal: move Lyncas's scheduling (and eventually its webhook) off GitHub Actions onto OpenClaw cron, run by Re-L on Harsh's machine._

## Three-step plan (short form)

**Step 1 — Replace the four GitHub Actions cron schedules with OpenClaw cron jobs**, running the same Python scripts from `~/trilogy/Lyncas/agent/` against the same Supabase + GitHub PAT. Leave the Actions workflow enabled in parallel as a safety net (PR-comment marker + Supabase unique index keep both paths idempotent). **Step 2 — Replace the GitHub → Vercel → `workflow_dispatch` webhook chain** with a direct OpenClaw HTTP receiver that runs `pr_reviewer.py --pr <repo>#<num>`, cutting the 60–90s cold-start to ~10–25s. Requires a stable public ingress to the OpenClaw host. **Step 3 — Retire the GitHub Actions workflow** once OpenClaw cron + webhook have run cleanly for ~1 week with matching Supabase row counts. The prompt-tuner and the manual benchmark stay where they are.

Tonight we completed Step 1. Step 2 is parked until there's a story for "what happens when this laptop sleeps" (likely answer: move to an always-on host, e.g. EC2).

## Registered OpenClaw cron jobs (Step 1)

All schedules in UTC; payloads source `agent/.env` and activate `agent/.venv` before running.

| # | Name | Schedule (UTC) | Local (IST) | Script | Delivery | Job ID |
|---|---|---|---|---|---|---|
| 1 | `lyncas:review` | `*/15 * * * *` | every 15 min | `agent/pr_reviewer.py` | none | `996379a1-8e89-4b9b-be23-7d46bdc6e08e` |
| 2 | `lyncas:digest` | `0 7 * * *` | 12:30 daily | `agent/send_digest.py` | none | `d6210513-2b1f-49ad-8e3d-7760a5cb254d` |
| 3 | `lyncas:poll-human-actions` | `0 */6 * * *` | every 6h | `agent/track_human_actions.py` | none | `d1106086-eb9d-4ce0-9a90-8179b3b0290e` |
| 4 | `lyncas:prompt-tuner` | `0 8 * * 1` | Mon 13:30 | `agent/prompt_tuner.py` (`GITHUB_REPOSITORY=trilogy-group/Lyncas`) | announce | `0f402807-cf1c-44ee-8431-60ee918abfa4` |
| 5 | `lyncas:health-summary` | `30 3 * * *` | 09:00 daily | inline Supabase REST query (reviews 24h, run errors 24h, undigested) | announce | `b2b01786-0d74-418f-a653-465eed4bf2bb` |

## Status

- GitHub Actions workflow (`pr-review.yml`) **still enabled** as safety net.
- Harsh will disable the Actions `*/15` schedule after 24h of clean OpenClaw runs.
- End-to-end test PR (#17 on `HarshBti1805/HackHelix-LLMHallucination`) confirmed the existing webhook → Actions path still works; review landed in ~46s and was correctly skipped on local re-run via the comment marker.
