# Business decisions

Companion to the [15–16 November 2026 project log](2026-11-16-project-log.md).
This page lists product and plan decisions. Times are in **Europe/Bucharest** (EET, UTC+2).
Engineering detail lives in the [ADR index](2026-11-16-project-log.md#adr-index).

## RunStage Gate

### Pivot to a merge-blocking quality gate — 15 November 2026

The project was started as **RunStage Gate**, a pivot from the earlier RunStage work into
a merge-blocking quality gate for AI-generated code. The product is three parts:

1. a GitHub App (and later a GitLab provider) that posts a `RunStage Gate` check;
2. an open-source runner that executes the real checks on the team's own machine;
3. a hosted run-history service.

The repository was created on 15 November 2026 at 11:35 (Europe/Bucharest) with that
description. See [ADR 0001](../adr/0001-stack.md).

### Local-only execution is a product principle — 15 November 2026

Checks always run on the team's own machines, where scripts, secrets and signed-in agent
CLIs already live. There is no hosted fallback that executes pull-request code. The App
creates check runs and enqueues work; the runner pulls jobs and runs them; CI for this
repository uses the self-hosted runner only.

This was written into the first-slice ADR and README on 15 November 2026, confirmed by a
read-only audit of `main` at `d1dfa87` on 16 November 2026, and is being machine-enforced
by a test on `feat/security-hardening` (not yet merged). See
[ADR 0002](../adr/0002-local-only-execution.md).

### The paid part is hosted history only — 15 November 2026

The runner is local and intended to stay open source. The paid offering is the hosted run
history (what ran, the results, who approved, and why a change passed or failed). The first
slice ships a local history stub in `apps/history` in place of that hosted service. There
is no billing integration yet.

### Free tier is capped at one repo; Plus unlocks more — 16 November 2026

The fleet status dashboard (one pane, red or green per connected repo, last-run time, link
to the failing check) is built as a presentation layer on existing history records.

- `RUNSTAGE_PLAN=free` (the default) shows exactly one repo: the first connected repo.
- `RUNSTAGE_PLAN=plus` shows every connected repo.
- The cap is enforced in the API as well as the page. There is no payment link.

This is implemented in open [pull request #18](https://github.com/cbursasiu/runstage-gate/pull/18)
and is not merged yet. See [ADR 0007](../adr/0007-free-plus-repo-cap.md).

### Going public, so GitHub Free can require the check — 16 November 2026

The gate only blocks merges when the `RunStage Gate` check (and, for this repository, the
CI `test` check) is a required status check. Research on 16 November 2026, from
[GitHub's pricing page](https://github.com/pricing),
[GitHub's plans documentation](https://docs.github.com/en/get-started/learning-about-github/githubs-plans)
and the
[protected branches documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches):

| Plan | List price as of 16 Nov 2026 | Required status checks on a **private** repo | On a **public** repo |
|---|---|---|---|
| GitHub Free | $0 | Not available (no protected branches on private repos) | Available |
| GitHub Pro (personal account) | $4 / month | Available | Available |
| GitHub Team (organization) | $4 / user / month (GitHub labelled this figure as applying to the first 12 months) | Available | Available |
| GitHub Enterprise | from $21 / user / month | Available, plus organisation-wide rules, SSO and audit features not needed for this | Available |

On any of these plans, GitHub Actions minutes on self-hosted runners are not billed, which
fits the local-only runner.

**GitLab** (from [GitLab's pricing page](https://about.gitlab.com/pricing/) and docs, also
16 November 2026):

- **Free** ($0, up to 5 users per group): the "Pipelines must succeed" merge check works on
  private projects and can accept pipelines reported by an outside CI tool. Using that path
  to block merges with a RunStage-reported commit status on the free tier was a reading of
  the docs, not something tested end-to-end in this project.
- **Premium**: $29 / user / month (unlimited users, approval rules, advanced CI/CD).
- **Ultimate**: price on request. Required for GitLab's dedicated "external status checks"
  feature. A check left pending there fails after two minutes.

These findings are why this repository was made public on the evening of 16 November 2026
and why `main` was then protected with required `test` and `RunStage Gate` checks. Public
visibility does not let strangers commit: they can only open pull requests from forks, and
only maintainers merge. The trade-off is operational, not "anyone can push": GitHub
advises caution with self-hosted runners on public repositories, so fork pull requests are
kept off this repository's self-hosted runner, and workflows from outside contributors are
meant to require approval. See [ADR 0006](../adr/0006-public-repo-and-branch-protection.md).

List prices can change; look up the vendor pages for current figures.

## TrackMaxima (high level only)

These decisions are recorded here because they were settled in the same period, across the
same set of bots. They do not change RunStage Gate.

### Logger first; Prep later; Train paused; other projects parked — 16 November 2026

On 16 November 2026 Manu decided that TrackMaxima work should focus on **Logger** first.
**Prep** is to be folded into Logger as one app later. **Train** is paused until there are
more resources. Other related projects are parked.

### Wellness framing — 16 November 2026

Apps in this line are framed as **wellness**, not medical: no dosing advice and no treatment
claims. That rule is already written into the Logger project's steering and is recorded here
only at that level of detail.

## Decision table

| Date (Europe/Bucharest) | Decision | Rationale |
|---|---|---|
| 15 Nov 2026 | Pivot to RunStage Gate (App + local runner + hosted history) | Merge-blocking checks for AI-generated code, run where the team's tools already live |
| 15 Nov 2026 | Local-only execution; no hosted fallback | Secrets and untrusted pull-request code stay on the team's machines |
| 15 Nov 2026 | Paid product is hosted history only | The runner stays local and open source |
| 16 Nov 2026 | Free fleet view shows one repo; Plus shows all | Simple entitlement, no billing yet |
| 16 Nov 2026 | Publish the repo and protect `main` | GitHub Free allows required checks on public repos only; private repos need Pro or Team |
| 16 Nov 2026 | Treat GitLab Free "Pipelines must succeed" as a possible free-tier enforcement path; dedicated external status checks need Ultimate | Documented GitLab plan differences; the commit-status path was not end-to-end tested |
| 16 Nov 2026 | TrackMaxima: Logger first, Prep folded in later, Train paused, other projects parked | Focus scarce time on one launch |
| 16 Nov 2026 | Wellness framing for those apps | Keep claims in a non-medical register |
