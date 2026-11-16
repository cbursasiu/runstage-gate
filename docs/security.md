# Security model

RunStage Gate runs untrusted pull request code on your own machine. This page says what protects
that machine and its secrets, and what does not. Everything here is free and local: no hosted
service, sandbox, or runner is involved.

## Trust boundaries

| Component | Trusts | Authenticated by |
|---|---|---|
| App ← GitHub | webhook deliveries | `X-Hub-Signature-256` HMAC-SHA256 with the webhook secret, compared in constant time (`@octokit/webhooks`). Missing headers → 400, bad signature → 401; nothing is handled or queued. |
| App ← GitLab | merge request hooks | `X-Gitlab-Token`, compared in constant time (SHA-256 of both sides, then `timingSafeEqual`). Missing or wrong → 401. |
| App ← runner | `jobs/next`, heartbeats, results | Per-runner bearer token. The App stores only SHA-256 hashes (`runners.json`), compares every entry in constant time, and takes the runner id from the token, never from a header. A runner can only heartbeat or complete jobs it claimed. |
| Runner ← App | jobs (what to check out and run) | **Signed jobs** (below). Unsigned, mis-signed, stale or replayed jobs are refused and the runner stops with a clear error. |
| History ← App | run records | Write token (Bearer); reads need the read or write token or a session cookie. |

### Signed jobs (App → runner)

Every `POST /api/runner/jobs/next` response carries

    x-runstage-job-signature: t=<unix ms>,n=<random nonce>,v1=<hex HMAC-SHA256>

over `v1\n<t>\n<n>\n<response body>`. The key is derived from the runner's own token, so there is
no second secret to distribute or rotate:

    key = HMAC-SHA256(key = SHA-256(runner token), "runstage-gate/job-signing/v1")

The App derives it from the stored hash; the runner from its plaintext token. Rotating the token
(`runner-token mint --id <id>`) rotates the signing key too.

The runner checks, before touching the repo:

- the MAC (constant-time compare), so the body (repo, shas, job id) cannot be altered;
- the timestamp is within ±5 minutes (`signatureMaxAgeMs`), so old responses expire;
- the nonce has not been seen in that window, so a captured response cannot be replayed.

Limits: anyone who can read `runners.json` on the App host can derive signing keys, so protect
that file like the private key (it lives in `.runstage-gate-data/`, which is git-ignored). The
channel is plain HTTP on localhost; if you ever expose the App beyond localhost, put TLS in front
of it, because the bearer token is sent in clear. Results posted by a runner are authenticated by
its token, not separately signed.

## Isolating PR code (runner)

Checks run in a fresh worktree of the PR head, with `.runstage/` pinned to the base commit (a PR
cannot change the checks that judge it). On top of that:

### Scrubbed environment

Checks never inherit the runner's environment. They get an allowlist: `PATH`, `LANG`, `LC_*`,
`TERM`, `TZ`, `USER`, `LOGNAME`, `SHELL`, plus `HOME` and `TMPDIR` pointing into the job's temp
directory, `CI=1`, `GIT_TERMINAL_PROMPT=0`, and the gate's own variables (`RUNSTAGE_BASE`,
`RUNSTAGE_HEAD`, `RUNSTAGE_REPO`, `RUNSTAGE_DIFF_FILE`, `RUNSTAGE_CHECK`, `RUNSTAGE_AI_*`).
So `RUNSTAGE_RUNNER_TOKEN`, `GITHUB_*`, cloud keys, `SSH_AUTH_SOCK` and similar never reach PR code.

`RUNSTAGE_CHECK_ENV_PASSTHROUGH=NAME1,NAME2` adds names (e.g. `JAVA_HOME`); names that look like
secrets or start with `RUNSTAGE_`, `GITHUB_`, `AWS_`, `SSH_` and similar are refused.

### macOS sandbox (`sandbox-exec`)

Set on the runner (never in gate.yml, so a PR cannot switch it off):

| Variable | Values | Default |
|---|---|---|
| `RUNSTAGE_SANDBOX` | `auto`: sandbox when `/usr/bin/sandbox-exec` exists, otherwise run unsandboxed with a warning in the log **and** on the check run. `required`: refuse to run checks without the sandbox (each check errors). `off`: no sandbox (warning still shown). | `auto` |
| `RUNSTAGE_SANDBOX_NETWORK` | `none` (no network at all, not even DNS), `loopback` (127.0.0.1/::1 only, e.g. tests that start local servers), `all` | `none` |

The profile:

- denies all file writes except the job's temp directory (worktree, `HOME`, `TMPDIR`, the diff)
  and the worktree's own git admin dir (`.git/worktrees/<name>`). The shared `.git` (objects,
  refs, hooks, config), your checkout, and your real home are read-only;
- denies network as configured above;
- denies reads (and writes) of well-known credential stores in your real home: `~/.ssh`,
  `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.config/gcloud`, `~/.azure`, `~/.kube`, `~/.docker`,
  `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.claude`, `~/.codex`,
  `~/Library/Keychains`, browser profiles and cookies.

Every check run says which mode applied (a 🔒 line when sandboxed, a ⚠️ line when not).

With `network: none`, a check cannot download dependencies (`npm ci` fails). Either use
`loopback`/`all` for that runner, or install dependencies outside the check. This is a runner
owner's choice, not the PR's.

**Agent checks** (`claude-code`, `codex`, custom; opt-in twice: `agents.enabled` and
`--allow-agents`) need their CLI's login and API access, so they run with the real `HOME`, full
network, and write access to their own config dirs (`~/.claude`, `~/.claude.json`, `~/.codex`),
still with the scrubbed env and all other write/read denials. Env names the agent CLI needs
(e.g. its API key variable) go in `RUNSTAGE_AGENT_ENV_PASSTHROUGH`.

### What the sandbox does not do (honest limits)

- It is not a VM or container. PR code runs as your user and can still **read** most of the
  filesystem (source of other projects, documents) outside the protected list. With network
  `none` it has no direct way to send that anywhere, but check **output** is posted to the check
  run; redaction (below) catches known secret formats, not arbitrary file contents.
- No CPU, memory, disk or process limits beyond the check's `timeout_seconds`.
- `sandbox-exec` is deprecated by Apple (still shipped and working on current macOS) and
  macOS-only. On other hosts `auto` runs unsandboxed with a warning; use `required` to refuse.
- `loopback` lets checks reach anything listening on localhost (the App on :3000, history on
  :3100, databases). Those endpoints require tokens, but prefer `none` where possible.
- For stronger isolation run the runner under a dedicated macOS user account, or in a local VM
  (both free); that is outside what RunStage Gate configures for you.

## Secrets out of logs and check output

A redaction helper (`packages/core/src/redact.ts`) is applied to:

- every runner log line and every result before the runner posts it;
- every App log line and every runner result before the App stores it, posts it to
  GitHub/GitLab, or sends it to history;
- every run the history service stores.

It replaces exact values of secrets the process holds (its runner token; env vars whose names
contain `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `PRIVATE_KEY`, `CREDENTIAL`, `WEBHOOK`…, at least
8 characters) and well-known formats: GitHub (`ghp_`, `ghs_`, `github_pat_`…), GitLab (`glpat-`),
RunStage runner tokens (`rsg_`), Slack, AWS access key ids, npm, OpenAI/Anthropic-style `sk-`
keys, JWTs, PEM private keys, `Bearer`/`Basic` values, `user:pass@` in URLs, and
`SECRET_NAME=value` pairs. It is best effort: a secret in an unknown format that the process
never held cannot be recognised. Do not print secrets in checks.

## Local-only principle

Checks always execute on your local runner. There is no hosted fallback anywhere:

- The App never executes code. Its only effect on GitHub is creating and updating its own check
  run; it does not call the Actions API, dispatch workflows, or start any hosted runner.
- The runner is the only component that runs checks (`packages/runner/src/execute.ts`), and it
  only runs jobs signed by your App.
- `.github/workflows/ci.yml` runs on `[self-hosted, macOS, ARM64]` only; a test
  (`apps/github-app/test/local-only.test.ts`) fails if any workflow job uses another `runs-on` or
  a reusable workflow.
- When no runner is online, the job stays queued and the check run stays in progress ("A runner
  on your team's machine will run the checks"); a claimed job whose runner disappears goes back to
  the queue when its lease expires. Nothing else picks it up. What should happen after a long
  wait is an open proposal (`docs/proposals/offline-runner.md`, branch `feat/offline-runner-proposal`).
