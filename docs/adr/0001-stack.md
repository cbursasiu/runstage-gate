# ADR 0001: Stack for the first slice

- Status: accepted
- Date: 2026-11-15

## Context

RunStage Gate is a merge-blocking check for pull requests that contain AI-generated code.
The checks must run on the team's own machines (where their scripts, secrets and signed-in
agent CLIs live), while the verdict has to land on the code host so branch protection can
block the merge. The paid part is the hosted run history.

The first slice needs to prove the loop end to end with as little infrastructure as possible,
on macOS first and Linux too.

## Decision

- **TypeScript on Node 20+, npm workspaces.** One language for the App, the runner and the
  history service; Node runs everywhere a developer already has `git`.
- **`packages/core`**: zod + yaml config schema for `.runstage/gate.yml`, gate evaluation,
  shared types, and a provider-neutral `CheckProvider` interface (`startCheck`,
  `completeCheck`). GitHub implements it with Check Runs. GitLab can implement it later with
  external commit statuses (all tiers) or Ultimate external status checks.
- **`apps/github-app`**: plain `node:http` server. `@octokit/webhooks` verifies signatures and
  routes `check_suite` and `pull_request` events. `@octokit/app` mints installation tokens for
  `checks.create` / `checks.update`. The Octokit surface is narrowed to a `ChecksClient`
  interface so tests and the demo never touch the network.
- **Runner transport: HTTP pull.** Runners call `POST /api/runner/jobs/next` and
  `POST /api/runner/jobs/:id/result` with a per-runner bearer token (SHA-256 hashes stored
  in a JSON file). Pull works behind NAT and laptop firewalls with no inbound ports. The
  queue is a single JSON file rewritten atomically (temp file, fsync, rename), with claim
  leases and heartbeats. We chose that over `node:sqlite` because the project targets
  Node 20 (`.nvmrc`), where `node:sqlite` doesn't exist, and the job volume per App is small.
- **`packages/runner`**: CLI `runstage-gate` with `run` (local dry run) and `poll`. Checks run
  in a throwaway `git worktree` of the PR head so the developer's checkout is never touched.
  The gate config is read from the PR's **base** commit so a PR cannot weaken its own gate.
  Agent checks shell out to already-installed CLIs (`claude -p`, `codex exec -`) and are off
  unless both the repo config and the runner allow them.
- **`apps/history`**: a stub with an in-memory/JSON store and `GET /runs`, standing in for the
  hosted, paid service.
- **Vitest** for tests, **tsx** to run TypeScript directly (no build step yet).

## Consequences

- No build step: the runner's `bin` registers tsx at startup. Publishing to npm will need a
  compiled build.
- Queued jobs survive restarts, but the queue file assumes a single App process. Scaling out
  needs a database behind the `QueueStorage` interface. History is still a stub.
- Runner tokens are per App; multi-tenant needs per-installation runner registration.
- Everything under `.runstage/` (config and check scripts) is loaded from the PR's base commit.
