# Lyncas — Design Brief for Claude Design

This document is the complete handoff package to redesign the **authenticated app UI** of Lyncas so it matches the quality and feel of our existing landing page.

It contains four things:
1. **The prompt** — paste this to Claude Design.
2. **The landing-page template** — the reference whose look we want carried through.
3. **The list of pages** to design, with their purpose and contents.
4. **Wireframes** — low-fidelity layout skeletons for each page.

> **Deliberately omitted:** colors, fonts, spacing scales, exact component styling. We want Claude Design to derive those itself from the landing-page reference and apply them consistently. Do not prescribe a palette or typeface.

---

## 1. THE PROMPT (paste this into Claude Design)

> I have a finished marketing landing page for a product called **Lyncas** — an autonomous GitHub PR-reviewing agent. I love the landing page's visual language. I now need you to design the **rest of the application** (the authenticated, logged-in product) so it feels like it was built by the same team, on the same day, as the landing page.
>
> **Your job:** Study the landing-page reference I'm providing below. Infer its full design system — its mood, its visual motifs, its sense of density and rhythm, its component vocabulary — and then extend that system into a complete set of **product/dashboard screens**. Define the design system yourself; do not ask me for colors, fonts, or tokens. Derive them from the reference and apply them with discipline and consistency across every screen.
>
> **Hard requirements:**
> - The product screens must look like a **direct continuation** of the landing page — same DNA, not a separate theme. A user moving from landing → login → app should never feel a seam.
> - These are **information-dense, working tool screens** (chat workspace, analytics dashboard with charts and tables, settings forms, config panels), not marketing pages. Carry the landing page's *aesthetic* but adapt it to dense, interactive, data-heavy layouts. Marketing flourish should give way to clarity and scannability where the screen is a working surface.
> - Design a **shared application shell** (navigation + page chrome) used by every authed screen, and show how the active nav state, user identity, and page titles live in it.
> - Design **reusable primitives** that recur across screens: stat/KPI card, data table (with sort/filter/pagination), chart container, form field + toggle, status pill/badge, empty state, button hierarchy, modal/drawer, toast. Show them once as a component sheet, then use them consistently in the page designs.
> - Define **states**: loading/skeleton, empty, error, and populated — at minimum for the data-heavy screens.
> - Cover **responsive behavior**: how multi-column screens (especially the 3-column chat workspace) collapse on tablet and mobile.
>
> **Deliverables:**
> 1. A short written summary of the design system you derived (motifs, hierarchy principles, component rules) — so the rest is reproducible.
> 2. A component/primitive sheet.
> 3. High-fidelity designs for each screen listed below, in both desktop and a representative mobile breakpoint.
> 4. The application shell shown with at least two different pages inside it.
>
> Below this prompt you'll find: (A) a structural template of the landing page so you can extract its system, and (B) the full list of screens with low-fi wireframes and a description of what each screen contains. Use the wireframes as **information architecture, not visual prescription** — improve the layouts freely as long as the content and hierarchy are preserved.

---

## 2. LANDING-PAGE TEMPLATE (the reference to extract the system from)

This is the structure of the page we love. It is a long, single-scroll marketing page. Reproduce/attach the live page if possible (`/landing`); this is the structural skeleton:

```
┌───────────────────────────────────────────────────────────────┐
│  NAV: [brand]            product  features  pricing   [Log in]  │  ← marketing nav, hairline bottom border
├───────────────────────────────────────────────────────────────┤
│                                                                 │
│   HERO  (dotted-grid background)                                │
│                                                                 │
│            [ NEW ]  Join Startups Program (underline link)      │
│                                                                 │
│              BIG MONO HEADLINE, two lines,                      │
│              second line is an inverted text block              │
│                                                                 │
│         supporting paragraph, centered, muted                   │
│                                                                 │
│            [ Start for free ]   [ View live demo ]              │  ← two-button row, primary is inverted
│                                                                 │
│            ── trusted-by logo marquee (scrolling) ──            │
│                                                                 │
│   ┌──────────┐   ┌──────────┐   ┌──────────┐                    │
│   │ ≡× LLM   │   │ ≡× SANDBOX│   │ ≡× OUTPUT│   ← "terminal     │
│   │  ascii   │   │  ascii    │   │  code ln │      windows":    │
│   │  art     │   │  art      │   │  lines   │      titled panel │
│   └──────────┘   └──────────┘   └──────────┘      w/ hairline   │
│                                                    header + body │
├───────────────────────────────────────────────────────────────┤
│   FEATURES   "> Hover (↓↓)"  (mono eyebrow)                     │
│   ┌─────────┬─────────┬─────────┐   ← 3×2 grid, cells divided   │
│   │ icon    │ icon    │ icon    │     by hairline gaps, each     │
│   │ title   │ title   │ title   │     cell: line-icon + title    │
│   │ body    │ body    │ body    │     + body + "Learn more" tag  │
│   ├─────────┼─────────┼─────────┤                                │
│   │ ...     │ ...     │ ...     │                                │
│   └─────────┴─────────┴─────────┘                                │
│              [ Try it ]   Read the source →                     │
├───────────────────────────────────────────────────────────────┤
│   PRICING   "> Hover (↓↓)"                                      │
│   ┌─────────┬───────────────┬─────────┐  ← 3 columns, middle    │
│   │ Hobby   │  PRO (filled, │ Enterprise│   one is highlighted  │
│   │ Free    │  inverted)    │ Custom   │     (inverted fill),    │
│   │ ✓ perk  │  $29/MO       │ ✓ perk   │     ✓-bulleted perks,   │
│   │ ✓ perk  │  ✓ perk       │ ✓ perk   │     full-width CTA per  │
│   │ [CTA]   │  [CTA]        │ [CTA]    │     column + footnote   │
│   └─────────┴───────────────┴─────────┘                          │
├───────────────────────────────────────────────────────────────┤
│   CTA / STATS  (dotted-grid background)                         │
│            Book a 30-min call today (link)                      │
│              BIG MONO HEADLINE, centered                        │
│              paragraph                                          │
│            [ Get started ]   [ View live demo ]                 │
│              ── trusted-by marquee ──                           │
│   ┌──────────┬──────────┬──────────┐  ← 3 stat tiles, big mono  │
│   │  <30s    │   1M+    │  3 gates │     number + mono caption  │
│   │ latency  │ LOC/mo   │ b4 close │                            │
│   └──────────┴──────────┴──────────┘                            │
├───────────────────────────────────────────────────────────────┤
│   FOOTER                                                         │
└───────────────────────────────────────────────────────────────┘
```

**Design DNA to carry forward (described, not prescribed — extract the actuals from the live page):**
- A small, recurring **"terminal window" panel motif**: a titled container with a thin header row (a label + an optional right-aligned status hint) and a body. This is the signature component and should recur in the product UI wherever we frame a unit of content.
- **Hairline-divided grids** — cells separated by 1px gaps rather than heavy boxes; structure comes from thin lines, not shadows or rounded cards.
- **Monospace for headings/labels/numbers**, with all-caps, wide-tracked micro-labels ("eyebrows") above sections.
- **Inverted blocks** used sparingly to mark the one important thing (the highlighted pricing column, a headline phrase, the primary button).
- **Dotted-grid texture** on hero/feature backgrounds; a very subtle film-grain over the flat background.
- **Two-tier button hierarchy:** primary (inverted/filled) vs. default (outline). Mono, uppercase, tracked CTA labels appear as small underline links for tertiary actions.
- Restrained, short **fade-up entrance motion**.
- **Severity/verdict accent colors** (a small semantic set: approve / request-changes / comment, and a 4-step severity ramp) exist for status — the product screens will lean on these heavily for review verdicts and severity scores. Extract them from the reference and treat them as the only chromatic accents.

---

## 3. SCREENS TO DESIGN

The product is a multi-tenant SaaS where a logged-in engineer connects GitHub repos and the agent reviews their PRs. After login the default screen is the **Chat workspace**. Top-level nav across all authed screens: **Chat · Overview · Repos · Reports · Settings**.

### Shared chrome (design once, reuse everywhere)
- **Application shell / nav**: top-level navigation with the 5 destinations above, active-state indication, and a user identity cluster (avatar, display name, email, sign-out).
- **Login screen**: bridges landing → app. Two auth paths: "Continue with GitHub" and email magic-link.

### The 6 authenticated screens

| # | Screen | Route | What it is |
|---|--------|-------|------------|
| 1 | **Login** | `/login` | GitHub OAuth + email magic-link. Branded, minimal. Has a "magic link sent" confirmation state and an error state. |
| 2 | **Chat workspace** ⭐ | `/dashboard/chat` | The flagship screen. A 3-column repo-aware chat. **Left rail:** repo picker, quick-action buttons, agent/sandbox connection status, project file tree. **Center:** chat message feed (markdown, code blocks, tables) + message composer. **Right rail:** repository research/insights, repo stats (open PRs, stars, last commit), contributors, languages. |
| 3 | **Overview** | `/dashboard/overview` | Analytics dashboard. Top row of **KPI stat cards** (total reviews, auto-closed, avg severity 30d, est. cost 30d, agent accuracy 30d). An **activity-over-time line/area chart** and a **severity-distribution bar chart**. A **per-repo summary table**. A large **recent-reviews table** with filters (repo, verdict, action, severity range), sorting, and pagination. |
| 4 | **Repos** | `/dashboard/repos` | The user's connected GitHub repos as a table/list: repo name, active/paused status pill, connected date, a "configure" affordance. "Add repos via GitHub" CTA. Empty state prompting GitHub-App install. |
| 5 | **Reports** | `/dashboard/reports` | Per-PR analysis reports, grouped by merge recommendation (merge / request-changes / reject / needs-review). Each report is an expandable card: PR metadata, analysis summary, status counts, download/copy actions. Empty state. |
| 6 | **Settings** | `/dashboard/settings` | Account preferences. **Notification settings** (digest email input, "send verification code", 6-digit OTP form, verified-status indicator). A **sandbox/dev-environment panel**. Links out to per-repo configuration. |
| 7 | **Per-repo settings** | `/repos/[owner]/[name]/settings` | Configure one repository: enable/disable toggle, auto-close options (toggle + severity-threshold slider), watch-paths and skip-paths (pattern lists), custom-instructions text, rules-file editor, repo file tree, save with success/error toasts. |

(Screen 7 is reached *from* the Repos screen; it shares the shell but is a focused config form.)

---

## 4. WIREFRAMES

Low-fidelity. **Information architecture, not visual spec.** Improve freely; preserve content and hierarchy.

### Application shell (wraps screens 2–7)
```
┌───────────────────────────────────────────────────────────────┐
│  [Lyncas]   Chat  Overview  Repos  Reports  Settings   (•avatar)│  ← active item marked
│             ▔▔▔▔                                        name/email
├───────────────────────────────────────────────────────────────┤
│                                                                 │
│                      « PAGE CONTENT »                           │
│                                                                 │
└───────────────────────────────────────────────────────────────┘
mobile: nav collapses to a hamburger / bottom-bar; identity in a menu.
```

### 1 — Login
```
┌───────────────────────────────┐
│                                │
│           [ brand mark ]       │
│         Sign in to Lyncas      │
│                                │
│   ┌──────────────────────────┐ │
│   │  Continue with GitHub    │ │  ← primary (inverted)
│   └──────────────────────────┘ │
│            — or —              │
│   [ email address ........... ]│
│   ┌──────────────────────────┐ │
│   │  Send magic link         │ │  ← default (outline)
│   └──────────────────────────┘ │
│                                │
│   states: ▸ "link sent, check  │
│            your inbox" ▸ error │
└───────────────────────────────┘
centered card on the landing background (dotted grid + grain).
```

### 2 — Chat workspace ⭐ (flagship; spend the most effort here)
```
┌──────────┬───────────────────────────────────┬──────────────┐
│ LEFT RAIL│  CENTER — CHAT                     │ RIGHT RAIL   │
│ (~220px) │  (flex)                            │ (~280px)     │
│          │                                    │              │
│ [repo ▾] │  ┌──────────────────────────────┐ │ Repo Insights│
│          │  │ agent msg (markdown, code,   │ │ ┌──────────┐ │
│ Quick    │  │  tables, verdict badges)     │ │ │ research │ │
│ actions: │  └──────────────────────────────┘ │ │ article  │ │
│ ┌──┬──┐  │              ┌────────────────────┐│ └──────────┘ │
│ │PR│Rev│ │              │ user msg (right)   ││ Stats:       │
│ ├──┼──┤  │              └────────────────────┘│  open PRs  N │
│ │Mrg│HC│ │  ┌──────────────────────────────┐ │  stars     N │
│ ├──┼──┤  │  │ agent msg w/ sandbox test    │ │  last commit │
│ │Br│Con│ │  │ result card                  │ │              │
│ └──┴──┘  │  └──────────────────────────────┘ │ Contributors │
│          │                                    │  ● ● ● ● …   │
│ ● agent  │                                    │ Languages    │
│   online │  ┌──────────────────────────────┐ │  ▓▓▓░░ TS    │
│          │  │ [ type a message… ]    [send]│ │  ▓░░░░ PY    │
│ Project  │  └──────────────────────────────┘ │              │
│ tree:    │                                    │              │
│  ▸ src/  │                                    │              │
│  ▸ app/  │                                    │              │
│  …       │                                    │              │
└──────────┴───────────────────────────────────┴──────────────┘
Note the "terminal window" motif fits the rail cards, the sandbox-result
card, and the composer nicely.
tablet: right rail collapses to a toggle/drawer.
mobile: single column — chat is primary; left & right become slide-in panels.
```

### 3 — Overview (analytics)
```
┌──────────────────────────────────────────────────────────────┐
│ > OVERVIEW   (mono eyebrow)                                    │
│ ┌────────┬────────┬────────┬────────┬────────┐                 │
│ │ Total  │ Auto-  │ Avg    │ Est.   │ Agent  │  ← KPI stat     │
│ │ reviews│ closed │ sev 30d│ cost30d│ acc 30d│     cards (the   │
│ │  1,204 │   38   │  4.2   │ $51.30 │  92%   │     stat-tile    │
│ └────────┴────────┴────────┴────────┴────────┘     motif)      │
│ ┌───────────────────────────┬──────────────────────┐          │
│ │ Activity (reviews/day 30d) │ Severity distribution│          │
│ │   /\    /\___               │  ▆ ▃ ▅ ▂            │          │
│ │  /  \__/      line/area     │  1-3 4-6 7-8 9-10   │          │
│ └───────────────────────────┴──────────────────────┘          │
│ ┌──────────────────────────────────────────────────┐          │
│ │ By repo   repo │ reviews │ closed │ avg severity   │          │
│ │  acme/web      │   312   │   9    │   3.8          │          │
│ │  acme/api      │   201   │   4    │   4.6          │          │
│ └──────────────────────────────────────────────────┘          │
│ ┌──────────────────────────────────────────────────┐          │
│ │ Recent reviews   [repo▾][verdict▾][action▾][sev⇅] │          │
│ │  ───────────────────────────────────────────────  │          │
│ │  repo  PR#  verdict-pill  sev  action   when       │          │
│ │  …                                                 │          │
│ │                              ‹ 1 2 3 … ›  (paged)  │          │
│ └──────────────────────────────────────────────────┘          │
└──────────────────────────────────────────────────────────────┘
verdict pills + severity numbers use the semantic accent colors.
needs: skeleton-loading + empty states for charts and tables.
```

### 4 — Repos
```
┌──────────────────────────────────────────────────────────────┐
│ > REPOS                              [ + Add repos via GitHub ]│
│ ┌──────────────────────────────────────────────────┐          │
│ │ repository      │ status   │ connected │  config  │          │
│ │ acme/web        │ ● active │ 3 days ago│   ⚙      │          │
│ │ acme/api        │ ● active │ 1 wk ago  │   ⚙      │          │
│ │ acme/legacy     │ ○ paused │ 2 mo ago  │   ⚙      │          │
│ └──────────────────────────────────────────────────┘          │
│ EMPTY STATE:  "No repos connected yet."                        │
│               [ Install the GitHub App ]                       │
└──────────────────────────────────────────────────────────────┘
```

### 5 — Reports
```
┌──────────────────────────────────────────────────────────────┐
│ > REPORTS                                                      │
│ ── MERGE ──────────────────────────────────────────            │
│ ┌──────────────────────────────────────────────────┐          │
│ │ acme/web #482  "Refactor auth"   merge ✓          │          │
│ │ summary line…                  [⌄ expand][⤓][copy]│          │
│ └──────────────────────────────────────────────────┘          │
│ ── REQUEST CHANGES ────────────────────────────────            │
│ ┌──────────────────────────────────────────────────┐          │
│ │ acme/api #77   "Add cache"   request-changes ⚠    │          │
│ │ summary…  [3 bugs · 2 nits]    [⌄][⤓][copy]       │          │
│ └──────────────────────────────────────────────────┘          │
│ ── REJECT ──   ── NEEDS REVIEW ──                              │
│ EMPTY STATE: install-GitHub-App prompt.                        │
└──────────────────────────────────────────────────────────────┘
group headers carry the verdict accent; expanded card shows the full report.
```

### 6 — Settings (account)
```
┌──────────────────────────────────────────────────────────────┐
│ > SETTINGS                                                     │
│ ┌── Notifications ─────────────────────────────────┐          │
│ │ Digest email   [ you@company.com ........ ]       │          │
│ │ status: ✓ verified  /  ⚠ unverified              │          │
│ │ [ Send verification code ]                        │          │
│ │ when sent →  [ _ _ _ _ _ _ ]  [ Verify ]          │          │
│ └──────────────────────────────────────────────────┘          │
│ ┌── Sandbox / Dev environment ────────────────────┐           │
│ │ connection status + config                       │           │
│ └──────────────────────────────────────────────────┘          │
│ ┌── Other ─────────────────────────────────────────┐          │
│ │ "Per-repo behavior is configured per repository →"│          │
│ └──────────────────────────────────────────────────┘          │
└──────────────────────────────────────────────────────────────┘
```

### 7 — Per-repo settings
```
┌──────────────────────────────────────────────────────────────┐
│ ‹ back to repos      acme/web  ›  settings                     │
│ ┌──────────────────────────────────────────────────┐          │
│ │ [✓] Reviews enabled for this repo                 │          │
│ ├──────────────────────────────────────────────────┤          │
│ │ Auto-close                                        │          │
│ │  [✓] Auto-close high-severity PRs                 │          │
│ │  severity threshold  1 ──────●──── 10  (=9)       │          │
│ ├──────────────────────────────────────────────────┤          │
│ │ Watch paths            │ Skip paths               │          │
│ │ [ src/**          ]    │ [ **/*.test.ts      ]    │          │
│ │ [ app/**          ]    │ [ vendor/**         ]    │          │
│ ├──────────────────────────────────────────────────┤          │
│ │ Custom instructions                               │          │
│ │ [ free text the reviewer reads… ]                 │          │
│ ├────────────────────────┬─────────────────────────┤          │
│ │ Rules file (editor)    │ Repo file tree           │          │
│ │ [ … ]                  │  ▸ src/  ▸ app/  …       │          │
│ └────────────────────────┴─────────────────────────┘          │
│                                  [ Save ]  → toast: saved ✓    │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. NOTES FOR THE DESIGNER

- **Continuity over novelty.** The single most important success criterion: the app must look like the same product as the landing page. When in doubt, reach for a motif already on the landing page (terminal-window panel, hairline grid, mono eyebrow, inverted accent) rather than inventing a new one.
- **Density is good here.** The landing page can breathe; the product screens are where engineers work. Tighten spacing, prioritize scannability, keep the aesthetic.
- **The chat workspace (screen 2) is the flagship** — it's the post-login default and the screen users live in. Give it the most polish.
- **Semantic accents only.** Beyond the monochrome base, the only color should be the verdict/severity semantic set. Use it on verdict pills, severity scores, status dots, and report group headers — nowhere decorative.
- **Show states.** For every data screen, design loading (skeleton), empty, and populated. Empty states should be inviting, with the relevant CTA (usually "install the GitHub App").
