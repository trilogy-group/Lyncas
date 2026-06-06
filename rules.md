# Lyncas — Custom Rules for HackHelix-LLMHallucination

## Auto-close rules
- Auto-close any PR that adds hardcoded API keys, tokens, or passwords, regardless of severity score
- Auto-close any PR that modifies authentication logic without corresponding test coverage
- Auto-close any PR with the title containing "test" or "demo" unless it includes actual test files

## Severity overrides
- Any PR touching .env files or config files with credentials → severity 10 automatically
- Any PR that disables or comments out security checks → severity 9 minimum
- README-only PRs → severity 1, approve automatically, do not close

## Review focus areas
- Flag all hardcoded strings that look like secrets (regex: sk-, ghp_, AIza, Bearer)
- Always check if new functions have corresponding error handling
- Flag any use of eval(), exec(), or dynamic code execution
- Flag SQL queries that are not parameterized

## What to ignore
- Minor typos in comments or documentation
- Code style issues (spacing, formatting) unless a linter config exists
- Test files that intentionally use mock credentials (clearly labeled as mocks)

## Tone
- Be direct and specific — name the exact file and line number when flagging issues
- Explain the security impact, not just that something is wrong
- Suggest a concrete fix for every bug flagged
