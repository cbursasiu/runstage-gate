# Contributor and agent guide

Short rules for people and coding agents working in this repository.

## Secrets

- Never commit keys, tokens, `.env` files or `.pem` files.
- Keep real values in local env (for example `~/.config/runstage-gate` or a gitignored `.env`) or the platform's secret store.
- gitleaks secret scanning runs in CI and in the gate.

`.env.example` is the checked-in template. `.gitignore` already ignores `.env*` (except `.env.example`) and `*.pem`.

## Local development

- Use the Node version in `.nvmrc`. After a clone: `npm ci`.
- Before opening a pull request, run `npm run typecheck`, `npm test` and `npm run demo`.
- Local App, runner and webhook setup is in [docs/local-testing.md](docs/local-testing.md).

## CI and the self-hosted runner

- The `CI (self-hosted)` workflow runs only on this repo's self-hosted macOS ARM64 runner. Do not change `runs-on` to GitHub-hosted labels (`ubuntu-latest`, `macos-latest`, and so on).
- Fork pull requests must not run on the self-hosted runner. The workflow already skips them; do not add `pull_request_target`.
- Checks defined in `.runstage/gate.yml` also run on the local RunStage Gate runner, not on GitHub-hosted runners.

## Git

- Work on a feature branch and open a pull request. Do not force-push or rewrite history on `main`.
