# Proposal: what the gate does when no local runner is online

Status: **proposal, not implemented. Decision: Cristian.**

RunStage Gate only ever runs checks on your own runner (see docs/security.md, "Local-only
principle"). There is no hosted fallback and this proposal does not add one. The open question is
only what the RunStage Gate check run on a PR shows, and whether it ever stops waiting, when no
runner picks up the job.

**Today** (main, `apps/github-app/src/github-provider.ts:68-69`): the App creates the check run as
`in_progress` with "RunStage Gate queued this change. A runner on your team's machine will run the
checks", and the job stays queued until a runner claims it, however long that takes. A claimed job
whose runner vanishes is re-queued when its lease (900 s) expires. That is option A.

Nothing in this proposal is implemented. No timeout or fail-on-offline code exists on any branch;
if B is chosen it would ship behind a setting that defaults off, so today's behavior stays the
default until changed on purpose.

## The options

**A. Stay pending.** The check stays `queued`/`in_progress` until a runner comes back. Optionally
the App refreshes the summary ("Waiting for a local runner since 09:12; no runner has polled for
2 h").

**B. Fail clearly after a timeout.** After a configurable wait (e.g. `RUNSTAGE_RUNNER_WAIT_SECONDS`;
unset means off) the App completes the check with conclusion `timed_out` (a failure) and a
summary like "No local runner picked this up within 24 h. Start the runner, then press Re-run."

## Trade-offs

| | A: stay pending | B: fail after timeout |
|---|---|---|
| **Merge blocking (required check)** | Blocks: a required check that never completes keeps the merge button disabled. | Blocks: `timed_out` counts as failing. Must **not** use `neutral` or `skipped`, which GitHub treats as passing for required checks; that would be a silent bypass. |
| **Merge blocking (check not required)** | Does not block: GitHub only shows "some checks haven't completed". This is the situation on this repo today: making a check required needs branch protection or rulesets, which for a **private** repo need **GitHub Pro** (paid; skipped under the no-cost rule). | Does not block either, but a red ✗ is a much stronger signal than a yellow dot when someone merges without required checks. |
| **Timeouts** | None on our side. GitHub itself marks a check run left incomplete for 14 days as `stale`. A runner that is offline for a weekend just catches up on Monday. | One new setting. Too short and a laptop asleep overnight fails every PR; too long and it adds little over A. Needs a periodic sweep in the App (it already has a background timer for report retries). |
| **Re-run** | GitHub only offers Re-run on completed check runs, so there is nothing to press; the queued job simply runs when the runner returns. Pushing a new commit also works. | Re-run is available on the `timed_out` check and goes through the existing `rerequested` flow (new job). Design choice: either drop the old job on timeout, or keep it queued so a returning runner completes the same check run automatically (nobody has to press anything). |
| **Approve override** | Not available: approvals only apply to a completed, failed gate. Nobody can wave a PR through while the runner is offline; an admin would have to bypass protection on GitHub itself. | The **Approve override** button appears on the `timed_out` check, so a maintainer could approve a PR whose checks never ran. Either exclude runner timeouts from approvals, or accept it as a documented escape hatch. |
| **PR UX** | Honest but ambiguous: a yellow dot looks the same for "running now" and "runner off for 3 days". Mitigated by refreshing the summary with how long it has waited and when a runner last polled. | Clear and actionable message, but red ✗s appear on PRs that did nothing wrong, and notifications go out for failures that are really "my laptop was asleep". |
| **Complexity** | Small: summary refresh plus "last runner poll" tracking. | Medium: sweep timer, new conclusion path, approval exclusion, tests for the runner returning after the timeout. |

## Possible paths (no decision made)

1. **A only** (today). Optionally add the "waiting since / last runner poll" summary refresh.
2. **A by default, B opt-in.** B behind a setting such as `RUNSTAGE_RUNNER_WAIT_SECONDS`, unset
   (off) by default. Open sub-choices: keep the job queued after the timeout or drop it; whether
   Approve override applies to runner timeouts.
3. **B by default**, with a chosen timeout.

Whichever path is chosen, B must use a failing conclusion (`timed_out`), never `neutral` or
`skipped`. And neither option blocks merges on this private repo until the check is required,
which needs GitHub Pro (a cost decision) or making the repo public.

Decision needed from Cristian: path 1, 2 or 3 (and, for 2 or 3, the timeout and the two sub-choices).
