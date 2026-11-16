# ADR 0005: Never commit secrets; scan in CI

- Status: accepted
- Date: 2026-11-16

## Context

Practice in this repository already kept real secrets out of git: `.gitignore` ignores
`.env*` except `.env.example`, and ignores `*.pem`; `.env.example` says not to commit
real values and to keep the App private key outside the repo; runner tokens are stored
as SHA-256 hashes. None of the steering or guide files had an explicit written rule.
The repository was about to be made public, so the rule needed to be obvious to people
and to coding agents, and a secret scan needed to run in CI as well as in the gate.

## Decision

- Add `AGENTS.md` with an explicit rule: never commit keys, tokens, `.env` files or
  `.pem` files; keep real values in local env or the platform's secret store; run a
  secret scan in CI and in the gate. Add a `CLAUDE.md` that points at `AGENTS.md`.
- Run gitleaks in the self-hosted CI workflow.
- Keep fork pull requests off the self-hosted runner in that same change, because a
  public repository would otherwise let untrusted workflow code reach the runner host.

This shipped in [pull request #16](https://github.com/cbursasiu/runstage-gate/pull/16)
(`0c19330`, 16 November 2026). A full-history gitleaks scan reported 0 findings before
the repository was made public.

## Consequences

- Agents and contributors have one short guide to follow. Ignore rules stay in place.
- CI fails if gitleaks is missing on the runner or if it reports a finding.
- The written rule does not by itself prevent a force-added secret; the scan and review
  are the backstop. Rotating any secret that did get committed remains a manual incident.
