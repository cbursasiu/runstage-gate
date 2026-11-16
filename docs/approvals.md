# Approvals (overriding a failed gate)

Sometimes a failing gate is wrong (a flaky check, an accepted exception). Anyone with
**write**, **maintain** or **admin** on the repo can override it. Both ways do the same thing:

1. **Approve override button.** Failed RunStage Gate check runs show an **Approve override**
   button at the top of the check (a GitHub check-run "requested action").
2. **`/runstage approve` comment.** Comment on the pull request with a comment that *starts*
   with `/runstage approve` (anything after it is free text, e.g. the reason).

What happens:

- The App finds the newest RunStage Gate job for the PR head commit (for the button, the job
  behind that check run). Approval is refused when that job is still running, passed, is
  already approved, or a newer run exists for the commit (`stale`).
- It checks the user's role with `GET /repos/{owner}/{repo}/collaborators/{username}/permission`.
  Only `admin`, `maintain` or `write` can approve. Bots' comments are ignored.
- It re-completes the same check run as **success**, titled `Approved by <login> (override): …`.
  The summary begins with who approved, how, when, and the original verdict, followed by
  the original summary and per-check table.
- The job in the queue gets `approvedBy`, `approvedAt` and `approvedVia`. A new history record
  is posted with `approvedBy` and the success result, and the history UI shows "Approved by".
  The original failing record stays.
- A new push (or **Re-run**) runs the gate again from scratch. Approvals don't carry over.
- Refused approvals are only logged by the App (`approval by X refused for …: reason`). Nothing
  is posted to the PR.
- If the check update fails (GitHub outage), it is retried like any other check update, and
  the retry keeps the approval.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RUNSTAGE_APPROVALS` | on | `0` turns approvals off: no button, and comments and clicks are ignored. |
| `RUNSTAGE_APPROVALS_ALLOW_SELF` | on | `0` stops a PR's author from approving their own PR. |

## GitHub App permissions and events

| Need | Permission / event | Used for |
| --- | --- | --- |
| Button | **Checks: Read and write** + **Check run** event (both already required) | `check_run.requested_action` |
| Role check | **Metadata: Read-only** (always granted) | collaborator permission lookup |
| Comment command | **Pull requests: Read-only** (already required) | finding the PR head sha |
| Comment command | **Issues: Read-only** + subscribe to **Issue comment** | receiving `issue_comment` webhooks |

The button works with the permissions documented in `docs/local-testing.md`. The comment
command only starts working once **Issue comment** events are delivered. To turn it on, open
the App settings, add **Issues: Read-only** under Permissions, tick **Issue comment** under
Subscribe to events, and accept the new permissions on the installation.

Branch protection must require the **RunStage Gate** check for an override to matter, because
otherwise a failing check doesn't block the merge in the first place.
