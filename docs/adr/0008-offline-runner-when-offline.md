# ADR 0008: What the check does when no runner is online

- Status: proposed
- Date: 2026-11-16

## Context

RunStage Gate never executes checks anywhere except the team's own runner
([ADR 0002](0002-local-only-execution.md)). Today the App creates the check run as
in progress and the job stays queued until a runner claims it. A claimed job whose
runner disappears is re-queued when its lease expires. GitHub itself marks a check
left incomplete for 14 days as `stale`.

That behaviour never fails a pull request just because a machine is asleep, but it
is ambiguous in the pull-request UI (a yellow dot looks the same as "running now"),
and Re-run / Approve override are not available while the check is still pending.

This ADR does not change the local-only rule. The open question is only what the
check run should show, and whether it should ever stop waiting.

Nothing described here is implemented. The write-up is
`docs/proposals/offline-runner.md` on `feat/offline-runner-proposal` (tip `754019d`).

## Decision

**Not decided.** Manu still needs to pick one of the following:

1. **A only** (today). Optionally refresh the summary with how long it has waited
   and when a runner last polled.
2. **A by default, B opt-in.** After `RUNSTAGE_RUNNER_WAIT_SECONDS` (unset means
   off) complete the check as `timed_out` (a failure) with instructions to start
   the runner and press Re-run.
3. **B by default**, with a chosen timeout.

If B is ever implemented it must use a failing conclusion (`timed_out`), never
`neutral` or `skipped`, because GitHub treats those as passing for required checks.
Sub-choices if B is picked: whether to keep the old job queued, and whether the
Approve override applies to a runner timeout.

## Consequences

- Until a choice is made, today's pending behaviour remains.
- Option B can fail pull requests when a laptop is asleep; option A cannot be
  re-run or approved while it is still waiting.
- Neither option blocks merges until the check is required, which this repository
  now has on `main` (see [ADR 0006](0006-public-repo-and-branch-protection.md)).
