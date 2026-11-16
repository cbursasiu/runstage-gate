# ADR 0007: Free / Plus repo cap on the fleet dashboard

- Status: accepted
- Date: 2026-11-16

## Context

Operators need a single-pane view of gate status across connected repositories: red or
green, the time of the last run, and a link to a failing check. The data already exists
in the history service's run records. The product also needs a free tier that is useful
but limited, without building billing in the first slice.

## Decision

- Add a fleet view (`GET /fleet` and `GET /api/fleet`) on the existing history service,
  behind the existing history login. This is a presentation layer: no new storage or
  queue. Optional, backward-compatible fields on the run record (`provider`,
  `externalCheckId`, `checkUrl`) exist only so a row can link to the check; older
  records still render and link to the history page.
- Plan is a single setting, `RUNSTAGE_PLAN=free|plus`, default `free`. Unknown values
  are treated as free. There is no payment link and no billing integration.
- On the free plan the dashboard shows exactly one repo: the first connected repo
  (earliest recorded run, ties broken by name). Further repos are counted, not named,
  with a notice that they need Plus. The cap is enforced in the shared view builder
  used by both the API and the page, not only in the HTML.

This is implemented in [pull request #18](https://github.com/cbursasiu/runstage-gate/pull/18)
(`feat/fleet-dashboard`) and is not merged at the time of this ADR.

## Consequences

- Until PR #18 merges, `main` has no fleet view and no plan flag.
- A known gap, reported with the pull request: the existing run list (`/` and `/runs`)
  is not plan-limited, so a free-plan user who can open that list can still see runs
  from other repos there. Whether to extend the cap is an open follow-up.
- Switching a deployment to Plus is a config change (`RUNSTAGE_PLAN`), not a payment
  flow, until billing is added later.
