# Source of truth

The Google Sheet "rank-and-rate-project" is the source of truth for this project's decisions and planning:
https://docs.google.com/spreadsheets/d/19NQYmNzB3lDn8jv4xUyCMDl-XZhu-oB8fdSYgfFQ3TQ/edit

- Tab "decisions": every product and technical decision (D001 onward), with status and superseded_by. Read it before suggesting or building anything, and follow active decisions over anything else, including older notes in this repo.
- Tab "planning-checklist": open questions and planning items, and whether each is done.
- To log a new decision, append a new row with the next ID. Never edit or delete old rows; to change one, add a new row and set the old row's superseded_by.
- Tab "hub": start here. Status at a glance and links to everything else.
- Other tabs: "tasks" (task tracker, with a needs_you column), "milestones" (estimated vs actual hours), "risks", "changelog" (what changed and when), "process" (Definition of Done, approval tiers, working rules), "success-metrics", and "confirmations" (default decisions waiting for my confirmation).
- Tabs "build-plan" (scope, key flows, architecture, secrets rule) and "data-model" (tables, formulas, who can do what, modules) describe what to build. Check them before writing code.
- All documentation for this project lives in the Sheet (D069). If something needs documenting and no tab fits, add a new tab.
- After finishing or starting a task, update its status on the "tasks" tab and add a row to "changelog".
- The repo holds code only. Don't create a local decisions.csv, a docs folder or similar files, and don't use one as a reference.
- The repo is public until at least 2026-11-10 (D096). Commit code only: no employer name, no secrets, no real data. Check the commits for these before any push.

If you can't reach the Sheet, ask me to paste the relevant rows instead of guessing.

# Code

- Needs Node 24 or newer. There is no install step yet. `npm test` runs every test with Node's built-in test runner (TypeScript with the types stripped).
- `src/scoring` holds every formula as a pure function. `db/` holds the migrations, the seed and the fake-night generator. Once the Worker exists, only its data module touches the database.
- `npm run db:fake -- --date=YYYY-MM-DD --nights=5` builds a local SQLite file in `.local/` with the 27 lines and fake nights; `npm run db:reset` starts over.
- `npm run dev:db` then `npm run dev` runs the site locally. The admin screen is `/admin`; supervisors sign up at `/sign-up` and sign in at `/sign-in`; local secrets are in `.dev.vars` (copy `.dev.vars.example`; never committed).

# GitHub Usage Rules (budget: ~3,000/month → target under 40/day)

GitHub is the last step, not a working tool. Do all work locally and only touch GitHub when a unit of work is finished.

## 1. When GitHub is allowed
Only these actions, and only when the condition is met:

| Action | Allowed when | Max frequency |
|---|---|---|
| `git push` | A feature/fix is complete, tests pass locally, and Isaac says "push" | Once per finished feature |
| `git pull` / `git fetch` | At the start of a session, or Isaac asks | Once per session |
| Open/merge a PR | Feature is done and Isaac approves | Once per feature |
| `gh` CLI / GitHub API calls | Isaac explicitly asks for it | Only on request |

Everything else (status checks, browsing files, reading history, diffs, branches, logs) uses **local git only**.

## 2. Never do these
- Never push after each small commit or "to save progress." Commit locally as often as you like; push once.
- Never run `gh` commands (pr list, issue view, run list, api, repo view, etc.) to "check" something. Ask Isaac instead.
- Never fetch files from github.com or raw.githubusercontent.com when the repo is already cloned locally.
- Never poll CI/Actions status or re-run failed workflows. Report the failure and wait.
- Never push to fix a typo, formatting, or a one-line change on its own. Bundle it into the next real push.
- Never create, delete, or re-push branches on the remote just to experiment. Experiment on local branches.
- Never `git fetch` / `git pull` repeatedly within the same session.

## 3. Work locally instead
| Instead of… | Use… |
|---|---|
| Checking remote status | `git status`, `git log --oneline -10` |
| Reviewing changes | `git diff`, `git diff --staged` |
| Running CI to test | Run tests/lint/build locally before any push |
| Viewing repo files on GitHub | Read the local clone |
| Remote experiment branches | Local branches, `git stash`, worktrees |
| Pushing to "back up" work | Local commits (they're already saved) |

## 4. Before every push — checklist
1. Feature is complete (not half-done).
2. Tests, lint, and build pass **locally**.
3. Related small fixes are bundled into this push.
4. Commits squashed into clean, meaningful commits (`git rebase -i` locally).
5. Isaac has said "push" (or approved the PR).
6. State in one line: what's being pushed and why.

## 5. CI / Actions / Deploys (biggest hidden cost)
Every push can trigger GitHub Actions runs and a Render auto-deploy.
- Workflows should run only on push to `main` and on PRs — not on every branch push.
- Add `paths-ignore` so docs/README/CSV-only changes don't trigger CI:
  ```yaml
  on:
    push:
      branches: [main]
      paths-ignore: ['**.md', 'docs/**', '**.csv']
    pull_request:
      branches: [main]
  ```
- Add `concurrency` with `cancel-in-progress: true` so stacked pushes don't each run a full job.
- Don't add new workflows, matrix builds, or scheduled (cron) workflows without asking.

## 6. If unsure
Don't call GitHub. Do it locally, or ask Isaac. A question costs nothing; a GitHub call costs budget.

## 7. Tracking
- Keep a running count of GitHub calls this session and report it at the end (e.g., "GitHub calls this session: 2 — 1 pull, 1 push").
- The adoption of these rules is logged in the Sheet's "decisions" tab as D068 (see Source of truth).
