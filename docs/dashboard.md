# Fleet status dashboard

One page that shows every connected repo at a glance: is the gate red or green, when did it
last run, and where do I click to see why.

- Page: `GET /fleet` on the history service (<http://localhost:3100/fleet>)
- JSON: `GET /api/fleet`
- Both sit behind the existing history auth: `Authorization: Bearer <read or write token>` or the
  browser session cookie from `/login`. Without credentials the page redirects to `/login` and the
  API returns `401` (when no history token is configured at all, history is open, as for every
  other route; local dev only).

## Where the data comes from

The dashboard is a presentation layer over the run records the App already posts to the history
service (`POST /runs`, one record per finished gate run, see `HttpHistorySink` in
`apps/github-app/src/handlers.ts`). It adds no storage, queue or background job; every request
reads the same in-memory `RunStore` the run list uses.

- **Connected repo**: any repo with at least one run in history.
- **Latest run**: per repo, the run with the newest `completedAt` (falling back to `createdAt`).
  Equal timestamps go to the run recorded later.
- **Order**: most recent activity first, then repo name A-Z.

### Status mapping

| Run record | Status | Colour |
| --- | --- | --- |
| `conclusion: "failure"` | `failing` | red |
| `conclusion: "success"` | `passing` | green |
| `conclusion: "success"` with `approvedBy` (failed gate overridden) | `passing (approved)` | green |
| in-progress state (`queued` / `in_progress`) | `pending` | yellow |
| anything else | `neutral` | grey |

History only receives *finished* runs, so `pending` does not occur with today's data: a repo whose
newest check is still waiting for a runner shows its previous finished run. The mapping exists so
a record that carries an in-progress state later renders correctly without a change here.

The row also lists the required checks that failed or errored in the latest run.

### Links

Each row links to the best place to see the latest run:

1. `checkUrl` recorded on the run: the GitHub check run page
   (`https://github.com/<owner>/<repo>/runs/<check_run_id>`, the same URL as the check run's
   `html_url`), or for GitLab the merge request (commit statuses have no page of their own).
2. Otherwise, for GitHub records that have the check run id (`externalCheckId`), the same URL is
   derived from it.
3. Otherwise (records written before this change), the history run detail page `/runs/<id>`.

A "Run details" link to the history page is always shown as well. Failing rows are labelled
"Failing: GitHub check run" so the click target is obvious.

#### Record change (backward compatible)

Before this change the run record had no provider or check run id, so a link to the check run
could not be built. The App now adds three **optional** fields to the payload it already posts:

| Field | Example | Notes |
| --- | --- | --- |
| `provider` | `"github"` | `"github"` or `"gitlab"`; missing means GitHub |
| `externalCheckId` | `"314"` | GitHub check run id (GitLab: status id) |
| `checkUrl` | `"https://github.com/acme/app/runs/314"` | built by `providerCheckUrl` in `packages/core/src/links.ts` |

Older records without them still load and render (they link to the history page), and an older
history server simply drops the unknown fields. `POST /runs` keeps only `http(s)` URLs without
credentials for `checkUrl`; anything else is discarded.

## Plans: free and Plus

There is no billing integration. The plan is a local config flag read in one place,
`apps/history/src/entitlements.ts` (`entitlements(env)`):

| `RUNSTAGE_PLAN` | Plan | Repos on the fleet dashboard |
| --- | --- | --- |
| unset, empty, `free` | free | exactly 1 |
| `plus` (any case) | Plus | all |
| anything else | free (fail closed, warning logged at startup) | exactly 1 |

`createHistoryServer(store, auth, { entitlements })` defaults to the free plan when no
entitlements are passed; `apps/history/src/main.ts` passes `entitlements(process.env)`.

### Which repo the free plan shows

**The first connected repo**: the repo whose earliest recorded run is oldest, ties broken by repo
name A-Z. This keeps the choice stable: a second repo getting busier never swaps out the repo you
started with.

When repos are hidden the page shows a notice such as
"2 more repos hidden. Upgrade to Plus to see every repo." with no payment link.

### Enforced in the API, not only the page

The limit is applied in `buildFleetView` (`apps/history/src/fleet.ts`), which both `/fleet` and
`/api/fleet` use. Hidden repos are counted (`hiddenRepos`, `totalRepos`) but never named in either
response.

The existing run list (`/`, `/runs`) is unchanged and not plan-limited; the plan applies to the
fleet dashboard only.

## `GET /api/fleet` response

```json
{
  "plan": "free",
  "maxRepos": 1,
  "totalRepos": 3,
  "hiddenRepos": 2,
  "selection": "free plan shows the first connected repo: the one whose earliest run is oldest (ties: repo name A-Z)",
  "notice": "2 more repos hidden. Upgrade to Plus to see every repo.",
  "repos": [
    {
      "repo": "acme/app",
      "provider": "github",
      "status": "failing",
      "color": "red",
      "approvedBy": null,
      "lastRunAt": "2026-11-16T10:00:05.000Z",
      "prNumber": 3,
      "headSha": "abcdef1",
      "title": "1 required check failed: tests",
      "failingChecks": ["tests"],
      "runId": "…",
      "detailUrl": "/runs/…",
      "link": { "url": "https://github.com/acme/app/runs/901", "kind": "github-check-run" },
      "runCount": 12,
      "firstSeenAt": "2026-11-15T10:00:00.000Z"
    }
  ]
}
```

`link.kind` is `github-check-run`, `gitlab-merge-request` or `history-run`. `maxRepos` is `null`
on Plus. Times are ISO 8601 in UTC; the page shows them in UTC too.

## Code

| File | What |
| --- | --- |
| `apps/history/src/entitlements.ts` | `RUNSTAGE_PLAN` → plan and repo limit |
| `apps/history/src/fleet.ts` | latest run per repo, status mapping, links, plan limit |
| `apps/history/src/html.ts` | `renderFleetPage` |
| `apps/history/src/server.ts` | `/fleet` and `/api/fleet` routes (behind read auth) |
| `packages/core/src/links.ts` | `providerCheckUrl` used by the App when posting a run |
| `apps/history/test/fleet.test.ts`, `entitlements.test.ts` | tests |
