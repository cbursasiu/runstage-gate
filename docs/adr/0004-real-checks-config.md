# ADR 0004: Real checks — gitleaks, ESLint and tests

- Status: accepted
- Date: 2026-11-16

## Context

The first slice proved the loop with an example check that failed a pull request if newly
added lines contained leftover to-do comments. That is useful as a demo, but it is not a
quality gate for this repository. Four candidates were considered for a real gate:
tests, lint, a secret scan, and a diff-size / untested-changes policy.

## Decision

Enable three required checks in this repository's gate, as implemented on
`feat/real-checks` (tip `8f8ecf8`, not yet merged):

- **secret-scan** — gitleaks over the pull-request range (`base..head`), with redaction
  so secret values do not appear in logs or check output;
- **lint** — ESLint, installed and run in the head worktree;
- **tests** — the Vitest suite on the pull-request head.

Document the config format with a JSON Schema and `docs/config.md`. Validate both this
repository's gate file and the examples against the parser and the schema.

**Do not enable** untested-changes or diff-size in this repository's gate. Keep them only
as examples:

- untested-changes (fail when source files change but no test file does) false-positives
  on refactors, type-only edits and lint fixes, and is easy to satisfy with an empty test
  file; the `tests` check already proves the suite runs;
- diff-size is a process limit, not a quality or security check, and pull-request sizes
  here vary.

The original leftover-comment example check remains under `examples/` for the demo and
runner tests.

## Consequences

- The gate becomes slower and needs `npm ci` in a clean worktree (handled by a helper
  script with a 600s timeout on the lint and tests checks).
- Until `feat/real-checks` is merged, `main` still dogfoods the first-slice example check.
- Repositories that want the untested-changes heuristic can copy the example script into
  `.runstage/checks/` and opt in explicitly.
