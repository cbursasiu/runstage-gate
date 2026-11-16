# ADR 0006: Public repository and protected main

- Status: accepted
- Date: 2026-11-16

## Context

The product only blocks merges when the `RunStage Gate` check is a required status check.
On 16 November 2026, GitHub's documented policy was:

- protected branches (including "Require status checks before merging") are available on
  **public** repositories with GitHub Free, including GitHub Free for organizations;
- they are not available on **private** repositories with GitHub Free;
- they are available on public and private repositories with GitHub Pro, GitHub Team and
  GitHub Enterprise.

GitHub Pro was listed at $4 per month for a personal account, and GitHub Team at $4 per
user per month (GitHub labelled that Team figure as applying to the first 12 months).
Keeping the repository private and enforcing the gate would therefore have required a
paid plan. Making it public allows enforcement on GitHub Free.

GitLab's free tier can require "Pipelines must succeed" on private projects; its
dedicated external status checks feature needs Ultimate. That informed later provider
work but was not the reason this GitHub repository was published.

Going public does not allow strangers to push to `main`. It does raise the risk of
untrusted fork pull requests running on the self-hosted runner.

## Decision

- Make [cbursasiu/runstage-gate](https://github.com/cbursasiu/runstage-gate) public.
- Protect `main`: require the `test` and `RunStage Gate` checks, include administrators,
  and block force pushes and deletions. Required approving reviews stay at zero so the
  owner can merge their own work once the checks pass.
- Require approval for workflows from outside contributors, and keep fork pull requests
  off the self-hosted runner (already enforced in the workflow after
  [pull request #16](https://github.com/cbursasiu/runstage-gate/pull/16)).

Dependency vulnerabilities flagged on `main` were fixed in
[pull request #17](https://github.com/cbursasiu/runstage-gate/pull/17) (`d93ee37`) as
part of going public. `npm audit` was then reported clean.

## Consequences

- Required checks work on GitHub Free. A paid GitHub plan is not needed for this
  repository's own enforcement.
- The source, issues and pull requests are world-readable. Secrets must stay out of git
  (see [ADR 0005](0005-no-secrets-in-git.md)).
- Self-hosted runners on a public repository need the fork and approval guards above.
  GitHub's own guidance is to be cautious in this configuration.
- Visibility is hard to undo in practice; this decision should not be reversed lightly.
