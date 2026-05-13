# Video script outline — night-pr-reviewer

**Target: 3 minutes. Casual tone. Don't make it a PowerPoint.**

Arleif's required structure:
1. Problem + why it's valuable (30 sec)
2. Demo the solution working (60 sec)
3. The 2-3 key links in the chain (60 sec)
4. The 2-3 key decisions (30 sec)

---

## Part 1 — Problem + value (~30 seconds)

> "I'm an intern. My team and I open PRs throughout the day, often into the evening. When I sit down in the morning, I have 3-5 PRs waiting that I should look at before doing my own work. Reviewing them takes me 30-60 minutes — and a chunk of that is just reading the diff to understand what changed before I can think critically about it.
>
> The valuable problem: **what if when I wake up, every PR opened overnight already had a first-pass review on it?** Not to replace my judgment, but to give me a head start. I'd know which PRs are clean, which have flagged concerns, and what questions to ask the author."

**Why this is valuable** *(say this explicitly — Arleif will check)*: every hour saved on review I spend on actual work, and the agent flags things I might have missed when reading too fast.

---

## Part 2 — Demo (~60 seconds)

Show, don't tell. Have these ready on screen:

1. **Show a clean PR** that the agent reviewed and approved — point out severity score is low
2. **Show a "terrible" PR** (e.g. hardcoded API key + auth bypass) that the agent **auto-closed** — point out:
   - The close reason comment with severity 9–10
   - The PR state is "Closed"
   - The "Reopen pull request" button (proves it's reversible)
3. **Show your inbox** with the morning digest — point to the 🚫 AUTO-CLOSED section at the top
4. **Show the GitHub Actions tab** — point to the hourly runs, say "this ran at 2am, this at 3am, this at 4am — laptop was off"
5. **Show a run log briefly** — token counts, gate decisions

Keep it moving. Don't narrate every click.

### How to seed the "terrible" PR for the demo

Open a PR with something like:
```python
AWS_SECRET_KEY = "AKIAIOSFODNN7EXAMPLE"  # production credential
def authenticate(user, password):
    return True  # auth bypass for "testing"
```
Claude will reliably score this 9–10 and trigger the close.

---

## Part 3 — Key links in the chain (~60 seconds)

> "Three things make this work — if any one was missing, the whole thing falls apart:"

**Link 1: GitHub Actions cron, not local cron**
> "Local cron only runs when my laptop is on. GitHub Actions runs in the cloud, free, hourly, even if my machine is off. This is what 'works while I sleep' actually requires."

**Link 2: The idempotency marker**
> "The agent puts an invisible HTML comment in every review it posts. Before reviewing a PR, it checks if that marker exists. Without this, it would re-review every PR every hour and spam them. This one comment line is what lets me run it on a tight cron without thinking about it."

**Link 3: Structured JSON output from Claude**
> "I force Claude to respond in a strict JSON schema — verdict, confidence, bugs with severity, questions. Two reasons: I can format the comment consistently, AND it pushes Claude to actually think in those categories instead of just dumping prose. The prompt also explicitly tells it 'don't invent code that isn't in the diff' and 'use the questions field when you're unsure' — because LLMs hallucinate, and a confident wrong review is worse than no review."

---

## Part 4 — Key decisions (~30 seconds)

> "Three decisions I want to call out:"

**Decision 1: Claude Sonnet over Opus**
> "Opus is overkill for code review. Sonnet handles this task well, costs about 5x less, and per Arleif's guidance you start with the lower model and only upgrade if quality is insufficient. Each review is under 2 cents."

**Decision 2: The agent CAN auto-close PRs — but only behind three gates**
> "I deliberately gave the agent teeth. It can close a PR autonomously, but only when all three gates pass: the verdict must be 'request_changes', the confidence must be 'high', AND the severity score must be 9 or 10 out of 10. The prompt explicitly defines what severity 9–10 means — not 'a bad bug' but 'this PR's existence is a problem' — like hardcoded secrets, deleting critical functionality, or obvious junk. Anything less just gets a comment, and I review it in the morning."
>
> "I made this trade-off knowingly: the agent's verdict can be wrong, but the gates make wrong closures rare, and any close is logged and surfaced first in my morning digest so I can audit it. Closing is also reversible — anyone can reopen the PR in one click, and the agent won't re-close it because of an idempotency marker."

**Decision 3: Never auto-merge, never push commits**
> "The agent has no write access to code, only to PR conversations. An autonomous agent that touches main while I sleep is how you wake up to a broken build. Close yes, merge no — because close is reversible and merge isn't."

---

## Bonus closer (if time)

> "What's not done yet: it doesn't re-review when new commits are pushed to an open PR — I'd version the marker to fix that. And it only reviews PRs on repos I own. Next iteration could add support for PRs I'm tagged on across other repos."

---

## What NOT to do in the video

- Don't show a slide deck
- Don't read this script word-for-word, it'll sound robotic
- Don't apologize for things being incomplete — say what works and what's next
- Don't say "I used Cursor and asked Claude to write it" — talk about the *decisions*, not the tools

## Recording tip

Open a tab with: the demo PR, your inbox, the Actions tab. Practice once, then record once. Don't edit.
