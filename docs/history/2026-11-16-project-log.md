# RunStage Gate project log — 15–16 November 2026

This log records how [cbursasiu/runstage-gate](https://github.com/cbursasiu/runstage-gate)
was started, hardened and published. Times are in **Europe/Bucharest** (EET, UTC+2) unless
a source timestamp is labelled otherwise.

Companion: [Business decisions](business-decisions.md).

## Summary

RunStage was pivoted into **RunStage Gate**: a merge-blocking quality gate for AI-generated
code, made of a GitHub App, a local runner, and a paid hosted history service. The repository
was created on **15 November 2026 at 11:35** (Europe/Bucharest) and the first slice was
committed minutes later. On **16 November 2026** the repo was made public so that GitHub Free
branch protection (required status checks) could enforce the gate, `main` was protected, and
dependency vulnerabilities on `main` were cleared. A fleet status dashboard (free tier: one
repo; Plus: all repos) is implemented in open [pull request #18](https://github.com/cbursasiu/runstage-gate/pull/18) and is not merged yet.

## Roles

| Role | What it does |
|---|---|
| **Manu** | Owner. Irreversible actions (going public, protecting `main`, merging work the bots hold) need his direct OK in the relevant bot's own chat. |
| **Indie Research** | Research and coordination. Looks up pricing and policy, drafts instructions, and reports results. It does not change this repository. |
| **RunStage Gate Builder** | The only bot that changes this repository. It runs tests on the Mac's local self-hosted runner, uses branches and pull requests, and holds irreversible or merge actions for Manu's direct OK. |
| **TrackMaximaLogger** | A separate bot for the Logger app, which is not this repository. See [Other work (Logger)](#other-work-logger). |

## Timeline

### 15 November 2026 — first slice

The repository was created at **11:35** (Europe/Bucharest) with the description "Merge-blocking
quality gate for AI-generated code: GitHub App + local runner + hosted run history", under
the Apache-2.0 license.

The first commits landed at **11:41** (Europe/Bucharest). That first slice included:

- a TypeScript / npm-workspaces scaffold and [ADR 0001](../adr/0001-stack.md) (stack for the first slice);
- `packages/core` (gate config schema, evaluation, a provider-neutral check interface);
- `apps/github-app` (webhook server that creates and completes the `RunStage Gate` check run);
- `packages/runner` (the `runstage-gate` CLI, with a local dry run and server polling);
- `apps/history` (a stub run-history service);
- an example gate config and an example check that failed a pull request if newly added lines contained leftover to-do comments;
- a README, a local-testing guide, and an end-to-end local demo with a mocked GitHub.

CI was first added, then briefly removed, then restored so tests run only on the local
self-hosted runner (`d698bed`, still the same morning). The workflow on `main` today uses
`runs-on: [self-hosted, macOS, ARM64]`.

Merged the same day:

| PR | Title | Merged (Europe/Bucharest) | Merge SHA |
|---|---|---|---|
| [#1](https://github.com/cbursasiu/runstage-gate/pull/1) | Load check scripts from the base commit, so a pull request cannot rewrite the checks that judge it | 15 Nov 2026, 13:05 | `daeb555` |
| [#2](https://github.com/cbursasiu/runstage-gate/pull/2) | Per-runner tokens (stored only as SHA-256 hashes) and a durable file-backed job queue | 15 Nov 2026, 14:53 | `a84cfbc` |
| [#3](https://github.com/cbursasiu/runstage-gate/pull/3) | Handle check re-runs; in poll mode, require `gate.yml` on the base commit (no working-tree fallback) | 15 Nov 2026, 14:58 | `cec9c34` |

### 16 November 2026 — early morning (overnight merges)

PRs #4 through #15 were merged between **04:34 and 05:26** (Europe/Bucharest). After this
batch, `main` was at `d1dfa87`.

| PR | Title | Merged (Europe/Bucharest) | Merge SHA |
|---|---|---|---|
| [#5](https://github.com/cbursasiu/runstage-gate/pull/5) | Create check runs via `octokit.request` (the App had been crashing when creating a check run) | 16 Nov 2026, 04:34 | `42a390f` |
| [#4](https://github.com/cbursasiu/runstage-gate/pull/4) | Add this repository's own gate config so the project can dogfood the gate | 16 Nov 2026, 04:36 | `62f6536` |
| [#8](https://github.com/cbursasiu/runstage-gate/pull/8) | De-duplicate concurrent `check_suite` and `pull_request` webhooks | 16 Nov 2026, 04:41 | `1743f1c` |
| [#7](https://github.com/cbursasiu/runstage-gate/pull/7) | Web UI for run history | 16 Nov 2026, 04:54 | `5ef2c88` |
| [#9](https://github.com/cbursasiu/runstage-gate/pull/9) | Token auth for the history UI and read API | 16 Nov 2026, 05:00 | `13f67f1` |
| [#10](https://github.com/cbursasiu/runstage-gate/pull/10) | Compiled build (`tsc -b` to `dist/`) | 16 Nov 2026, 05:02 | `8150549` |
| [#11](https://github.com/cbursasiu/runstage-gate/pull/11) | Small hardening: runners file required, contained `.runstage` symlinks, agent base check, check-update retry | 16 Nov 2026, 05:07 | `8b88a8a` |
| [#12](https://github.com/cbursasiu/runstage-gate/pull/12) | Approvals: an Approve override button and `/runstage approve` | 16 Nov 2026, 05:12 | `b4e4222` |
| [#13](https://github.com/cbursasiu/runstage-gate/pull/13) | Heuristic AI-generated change detection with a `gate.yml` policy | 16 Nov 2026, 05:18 | `1e17de1` |
| [#14](https://github.com/cbursasiu/runstage-gate/pull/14) | GitLab commit-status provider and `merge_request` webhook | 16 Nov 2026, 05:22 | `ecdb035` |
| [#15](https://github.com/cbursasiu/runstage-gate/pull/15) | Runner keeps polling through App restarts and retries posting results | 16 Nov 2026, 05:26 | `d1dfa87` |

[PR #6](https://github.com/cbursasiu/runstage-gate/pull/6) (`test/gate-e2e`) was a throwaway
end-to-end test pull request. It was closed unmerged, on purpose.

### 16 November 2026 — local-only audit and three work branches

A read-only audit of `main` at `d1dfa87` confirmed that execution is local-only everywhere:
CI uses `runs-on: [self-hosted, macOS, ARM64]`; the App only creates check runs and enqueues
work; the runner pulls jobs; there is no hosted fallback. The gap was that nothing in the
test suite machine-enforced this. That guard was added on `feat/security-hardening` (see
below) and is not on `main` yet.

Three feature branches were built as local commits first, then pushed to the remote on the
evening of 16 November 2026 as branches only (no pull requests, no merges). Heads as of
this log:

#### `feat/security-hardening` — tip `b8c7b81`

| Commit | What it adds |
|---|---|
| `30e7757` | HMAC job signing (timestamp + nonce) and secret-redaction helpers |
| `656393f` | Signed App-to-runner jobs, redacted logs and results, webhook auth tests |
| `eb43aae` | Scrubbed check environment and macOS `sandbox-exec` isolation (no network by default; writes limited to the job folder; well-known credential paths such as `~/.ssh` and the Keychain are blocked) |
| `1691b1e` | Local-only guard test (`apps/github-app/test/local-only.test.ts`) and `docs/security.md` |
| `b8c7b81` | CI workflow test: reject GitHub-hosted `runs-on` labels |

Job signatures use a 5-minute window and a one-time nonce; unsigned, stale or replayed jobs
are refused. These commits are on the branch only.

#### `feat/real-checks` — tip `8f8ecf8`

Commit `8f8ecf8` replaces the example leftover-comment check with three real checks:
a redacted gitleaks scan of the pull-request range, ESLint, and the Vitest suite. It also
adds a JSON Schema for the gate config and `docs/config.md`.

**Untested-changes** and **diff-size** were considered and kept only as examples, not enabled
in this repository's gate:

- untested-changes (fail when source files change but no test file does) false-positives on
  refactors, type-only edits and lint fixes, and is easy to satisfy with an empty test file;
  the `tests` check already proves the suite runs;
- diff-size is a process limit, not a quality or security check, and pull-request sizes here vary.

#### `feat/offline-runner-proposal` — tip `754019d`

`docs/proposals/offline-runner.md` (on this branch; also summarised in
[ADR 0008](../adr/0008-offline-runner-when-offline.md), status **proposed**) presents options
and does **not** implement any of them. Manu has not chosen yet.

- **Option A** (today): the check stays in progress until a runner claims the job. It never
  fails wrongly, but there is no Re-run or Approve override while it is still pending.
- **Option B**: after a timeout, complete the check as `timed_out` (a failure). Clearer, but
  a machine that is asleep can fail pull requests.
- A middle path: B behind a switch that is off by default.

Neither option blocks merges until the check is a required status check.

### 16 November 2026 — evening: push, scan, no-keys rule, audit fix, going public

**The push "issue":** there was no push failure. The three feature branches were held back on
purpose until Manu confirmed they could be pushed. After that confirmation they were pushed
to `origin` as branches only. The RunStage Gate Builder bot then reported a full-history
gitleaks scan over 26 refs (including the newly pushed branches) with 0 findings, and that
no `.env` or `.pem` file has ever been committed.

| PR | Title | Merged (Europe/Bucharest) | Merge SHA |
|---|---|---|---|
| [#16](https://github.com/cbursasiu/runstage-gate/pull/16) | `AGENTS.md` no-keys rule, a `CLAUDE.md` pointer to it, a same-repo-only guard so fork pull requests do not run on the self-hosted runner, and gitleaks in CI | 16 Nov 2026, 20:07 | `0c19330` |
| [#17](https://github.com/cbursasiu/runstage-gate/pull/17) | Fix npm audit findings before going public | 16 Nov 2026, 20:16 | `d93ee37` |

PR #17 cleared `npm audit` on `main` to 0 findings (reported: CI run
[43926524473](https://github.com/cbursasiu/runstage-gate/actions/runs/43926524473) passed,
the RunStage Gate check passed, 146 tests passed, gitleaks clean):

| Package | From | To | Advisory | Severity | Dev or runtime |
|---|---|---|---|---|---|
| tinypool (transitive via vitest) | 1.1.1 | removed (vitest 4 no longer depends on it) | [GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3), [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr) | critical | dev |
| @vitest/mocker (transitive via vitest) | 3.2.7 | 4.1.12 | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) / related mocker advisories, including [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8) as reported | moderate | dev |
| vitest (direct) | 3.2.7 | 4.1.12 | clears the critical tinypool findings above | critical (via dep) | dev |
| zod | 3.25.76 | 4.6.7 | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | high | runtime, in core |

Zod 3 had no patched release, so the fix was a major bump. The trade-off was reported as
small: one renamed constant and explicit object defaults. Vitest was taken to 4.1.12 rather
than forced to 5.

**Visibility and branch protection.** After a further secret scan, the repository was made
public on the evening of 16 November 2026 (Europe/Bucharest), shortly before PR #17 merged
at 20:16. The exact minute is not independently confirmed from the public GitHub Events API
(see [Notes](#notes-and-unverified-items)). The reasons are in
[Business decisions](business-decisions.md): required status checks on a **private** repo
need a paid GitHub plan; on a **public** repo, GitHub Free allows them.

`main` is protected (verified via the GitHub API on 16 November 2026):

- required status checks: `test` and `RunStage Gate`;
- administrators are included (`enforce_admins`);
- force pushes are blocked;
- deletions are blocked.

The protection requires a pull request and zero required approving reviews, so the owner
can still merge their own work once the checks pass.

The RunStage Gate Builder bot reported that fork-pull-request workflow approval was set to
`all_external_contributors` (workflows from outside contributors wait for approval). This
could not be re-read from the public-repo REST API after the fact (see Notes). Independently
of that setting, the CI workflow already skips jobs when the pull request comes from a fork
(`0c19330`).

### Fleet dashboard — open PR #18

[Pull request #18](https://github.com/cbursasiu/runstage-gate/pull/18), branch
`feat/fleet-dashboard`, head `7342c1d` as of this log, is **open** and not merged. CI `test`
and `RunStage Gate` had both passed on that head. 176 tests were reported passing on the
branch (146 on `main`).

It is a presentation layer on existing run-history records (plus optional, backward-compatible
`provider`, `externalCheckId` and `checkUrl` fields so a row can link to the check):

- `GET /fleet` (page) and `GET /api/fleet` (JSON), both behind the existing history auth;
- one row per connected repo: red/green status, last-run time, and a link to the failing check
  (falling back to the history run page on older records);
- `RUNSTAGE_PLAN=free|plus` (default `free`). Free shows exactly one repo — the first
  connected repo (earliest recorded run, ties by name) — plus a notice that further repos
  need Plus. There is no payment link and no billing integration. The cap is enforced in
  `buildFleetView`, used by both the API and the page.

Merging PR #18 is still waiting on Manu's OK.

## Decision log

| Date (Europe/Bucharest) | Decision | Rationale | Link |
|---|---|---|---|
| 15 Nov 2026 | Pivot to RunStage Gate: GitHub App + local runner + hosted history | A merge-blocking check for AI-generated pull requests, with checks running where scripts, secrets and agent CLIs already live | [Business decisions](business-decisions.md), [ADR 0001](../adr/0001-stack.md) |
| 15 Nov 2026 | TypeScript, Node 20+, npm workspaces, HTTP-pull runner, file-backed queue | One language; pull works behind NAT; Node 20 has no `node:sqlite` | [ADR 0001](../adr/0001-stack.md) |
| 15 Nov 2026 | Local-only execution; no hosted fallback | Checks and secrets stay on the team's machines | [ADR 0002](../adr/0002-local-only-execution.md) |
| 15 Nov 2026 | The paid product is hosted run history | The runner is open source and local; history is the hosted, paid service | [ADR 0001](../adr/0001-stack.md), [Business decisions](business-decisions.md) |
| 15 Nov 2026 | Per-runner tokens and a durable job queue | A shared in-memory token/queue was too weak and lost work on restart | [PR #2](https://github.com/cbursasiu/runstage-gate/pull/2), [ADR 0003](../adr/0003-runner-tokens-and-signed-jobs.md) |
| 15 Nov 2026 | Load check scripts from the base commit | A pull request must not be able to rewrite its own judge | [PR #1](https://github.com/cbursasiu/runstage-gate/pull/1) |
| 16 Nov 2026 | Sign jobs, sandbox checks, redact logs; add a test that CI stays self-hosted | Close the gap that local-only was not machine-enforced; reduce risk of running untrusted pull-request code on a personal machine | `feat/security-hardening` (`b8c7b81`), [ADR 0003](../adr/0003-runner-tokens-and-signed-jobs.md) (implementation not yet on `main`) |
| 16 Nov 2026 | Real checks: gitleaks, ESLint, tests; untested-changes and diff-size stay examples | Those two policies measure process or are easy to game; the suite, lint and secret scan measure quality and safety | `feat/real-checks` (`8f8ecf8`), [ADR 0004](../adr/0004-real-checks-config.md) (implementation not yet on `main`) |
| 16 Nov 2026 | Offline-runner behaviour left open (options A, B, or B behind a default-off switch) | Trade-offs affect merge UX and false failures when a machine is asleep | [ADR 0008](../adr/0008-offline-runner-when-offline.md) (proposed), branch `feat/offline-runner-proposal` |
| 16 Nov 2026 | Written no-keys rule in `AGENTS.md`; gitleaks in CI; fork pull requests stay off the self-hosted runner | The rule had been practice and ignore-rules only, not an explicit guide | [PR #16](https://github.com/cbursasiu/runstage-gate/pull/16), [ADR 0005](../adr/0005-no-secrets-in-git.md) |
| 16 Nov 2026 | Make the repository public and protect `main` | GitHub Free allows required status checks on public repos, not on private repos | [Business decisions](business-decisions.md), [ADR 0006](../adr/0006-public-repo-and-branch-protection.md) |
| 16 Nov 2026 | Clear the npm audit findings on `main` before / as part of going public | 2 critical, 1 high and 1 moderate findings were flagged on `main` | [PR #17](https://github.com/cbursasiu/runstage-gate/pull/17) |
| 16 Nov 2026 | Fleet dashboard: free tier shows exactly one repo; Plus shows all | A single-pane status view, with a simple plan flag and no billing yet | [PR #18](https://github.com/cbursasiu/runstage-gate/pull/18) (open), [ADR 0007](../adr/0007-free-plus-repo-cap.md) |

## ADR index

ADRs live in [`docs/adr/`](../adr/). Numbering continues from the existing stack ADR.

| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](../adr/0001-stack.md) | Stack for the first slice | accepted | 2026-11-15 |
| [0002](../adr/0002-local-only-execution.md) | Local-only execution, no hosted fallback | accepted | 2026-11-15 |
| [0003](../adr/0003-runner-tokens-and-signed-jobs.md) | Per-runner tokens and signed jobs | accepted | 2026-11-15 (tokens on `main`); signed jobs implemented on `feat/security-hardening`, not yet merged |
| [0004](../adr/0004-real-checks-config.md) | Real checks: gitleaks, ESLint, tests | accepted | 2026-11-16 (on `feat/real-checks`, not yet merged) |
| [0005](../adr/0005-no-secrets-in-git.md) | Never commit secrets; scan in CI | accepted | 2026-11-16 |
| [0006](../adr/0006-public-repo-and-branch-protection.md) | Public repository and protected `main` | accepted | 2026-11-16 |
| [0007](../adr/0007-free-plus-repo-cap.md) | Free / Plus repo cap on the fleet dashboard | accepted | 2026-11-16 (in open PR #18) |
| [0008](../adr/0008-offline-runner-when-offline.md) | What the check does when no runner is online | **proposed** | 2026-11-16 |

Other-repo ADRs (for example TrackMaxima Logger launch-prep ADRs written as Proposed in that
private repository on 16 November 2026) are not copied here.

## Git tags

None. `GET /repos/cbursasiu/runstage-gate/tags` returned an empty list when this log was written.

## Pending decisions

- **Offline runner:** option A, option B, or B behind a default-off switch. See [ADR 0008](../adr/0008-offline-runner-when-offline.md).
- **Merging [PR #18](https://github.com/cbursasiu/runstage-gate/pull/18)** (fleet dashboard).
- **`package.json` `repository`, `homepage` and `bugs` fields**, which are still missing now that the repository is public.
- Opening pull requests for the already-pushed `feat/security-hardening`, `feat/real-checks` and `feat/offline-runner-proposal` branches, and merging them, still needs Manu's OK.
- An open follow-up from the security work: with the sandbox default of no network, a tests check cannot download packages inside the sandbox; that is a runner-owner choice (`loopback` / `all`, or install dependencies outside the check), not yet a written default beyond `docs/security.md` on the security branch.

## Other work (Logger)

The TrackMaximaLogger bot works on a separate app, not this repository. On 16 November 2026
Manu decided to focus that product line on Logger first (see
[Business decisions](business-decisions.md)). The Logger bot prepared and then merged
launch-prep documentation, a feature branch, and dependency triage in its own repo, and
drafted website legal pages that remain waiting on Manu's review. No further detail belongs
in this public log.

## Notes and unverified items

- Indie Research's own long-running transcript could not be re-opened from the drafting
  session that wrote this file. Facts above are taken from the GitHub repository (commits,
  pull requests, APIs), from the RunStage Gate Builder and TrackMaximaLogger transcripts,
  and from call instructions already relayed in this coordination thread. Anything not
  confirmed that way is marked here.
- The exact clock time the repository visibility changed to public was not found as a
  distinct `PublicEvent` on 16 November in the GitHub Events API. The only `PublicEvent`
  returned was dated 15 November 2026, 11:35 (Europe/Bucharest), which is also
  `created_at`. The visibility change itself is attested by the Gate Builder bot's report
  on the evening of 16 November and by the repository being public when this log was written.
- Fork workflow approval set to `all_external_contributors` is attested by the Gate Builder
  bot. The REST endpoint that reads fork-PR workflow settings rejected the query on this
  now-public repository, so it was not re-verified via API.
- Advisory IDs and package version bumps for PR #17 follow the Gate Builder report and the
  merged pull request; they were not re-run through `npm audit` while writing this log.
- The 26-ref gitleaks result (0 findings) is the Gate Builder bot's report, not a scan
  re-run from this drafting session.
- GitHub and GitLab list prices were researched on 16 November 2026 and can change; see
  [Business decisions](business-decisions.md).
