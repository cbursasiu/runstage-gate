# ADR 0002: Local-only execution, no hosted fallback

- Status: accepted
- Date: 2026-11-15

## Context

RunStage Gate has to run a team's real scripts, tests and optional agent CLIs. Those
depend on local files, local credentials and already-signed-in tools. Sending pull-request
code to a hosted runner would move secrets and untrusted code off the team's machines,
and it would contradict the product promise that no code or secrets go to the service's
servers.

The first slice therefore needed a hard rule: the hosted pieces may coordinate, but they
may not execute the checks.

## Decision

- Checks execute only on a runner the team operates. There is no hosted fallback, and one
  will not be added as a convenience when no runner is online.
- The GitHub App (and the GitLab provider) create and complete check runs and enqueue
  work. They do not run check scripts, dispatch GitHub Actions, or start a hosted runner.
- This repository's own CI uses `runs-on: [self-hosted, macOS, ARM64]` only.
- When no runner is online, the job stays queued and the check stays in progress. What
  the check should show after a long wait is a separate, still-open question
  ([ADR 0008](0008-offline-runner-when-offline.md)).

A read-only audit of `main` at `d1dfa87` on 16 November 2026 confirmed this architecture
was already in place, but that nothing in the test suite machine-enforced the CI half of
the rule. A guard test that fails if any workflow job leaves the self-hosted runner lives
on `feat/security-hardening` and is not on `main` at the time of this ADR.

## Consequences

- A sleeping or offline machine delays (and, once the check is required, blocks) merges.
  That is accepted, rather than silently running the same checks in a hosted environment.
- Publishing the runner and dogfooding CI on a personal machine requires extra care once
  the repository is public (fork pull requests must not run on that machine).
- Operators cannot "fail over to the cloud" for convenience. Capacity planning is local.
